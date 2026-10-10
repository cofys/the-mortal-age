"use strict";

// CitizenGoalChatter unit checks — pure logic, no running server.
//
// Verified real data shapes these tests are built on (from
// server/plugins/citizens/lib/CitizenBossRuns.js and CitizenBonds.js):
//
//   bossById(bossId) returns a BOSSES entry with .label (e.g. "the Giant Mole")
//   or null. Party objects from createParty: { id, leader, members } — boss
//   runs add bossId/activity, phase ("travel"|"fight"), bossSeen (bool).
//   The module must never name a boss that isn't in BOSSES.
//
//   getInvites(name) returns pending invites shaped EXACTLY:
//     { id, kind, from, fromDisplay, to, createdAt, expiresAt, data }
//   where kind is one of the INVITE_* constants. TTL is checked by getInvites
//   itself — expired invites never reach the chatter.
//
//   bonds(name).friends is the real promoted-friend list; isFriend(a, b) is
//   directed. The announced-friends set is seeded from current lists on the
//   first tick so restarts never re-announce old friendships.
//
// Tests inject fakes through the overrides, so no test depends on the live
// stores, files being written, or a running server.

const assert = require("node:assert/strict");
const Chatter = require("./CitizenGoalChatter");
const { BAND_NEAR, BAND_FAR } = require("../lib/CitizenTickLod");

const {
  tickBossGoalChatter,
  tickFriendGoalChatter,
  _resetForTests,
  _bossPartiesFor,
  _bossLabelOf,
  _chatterChance,
  _fillTemplate,
  _nextPartyChatterAt,
  _nextFriendChatterAt,
  BOSS_FIGHT_MIN_MS,
} = Chatter;

// --- mocks (same shape as CitizenWarChatter.test.js) --------------------------

function makeRealPlayer(username = "Cofy") {
  return {
    getUsername: () => username,
    isPlayerBot: () => false,
    getHostAddress: () => "127.0.0.1",
  };
}

function makeBot({
  username = "Mira",
  personality = { traits: ["chatty"] },
  locals = [],
} = {}) {
  const forced = [];
  return {
    bot: {
      getUsername: () => username,
      getAttribute: (k) => (k === "citizens:personality" ? personality : null),
      getLocalPlayers: () => locals,
      forceChat: (text) => forced.push(text),
    },
    forced,
  };
}

// director with a configurable roster (records keyed by lowercase username)
function makeDirector(entries, getBotByName) {
  const roster = new Map();
  for (const e of entries) roster.set(e.username.toLowerCase(), e);
  return {
    roster,
    isOnline: () => true,
    getBot: (record) => (getBotByName ? getBotByName(record) : null),
  };
}

function makeOverrides(extra = {}) {
  const said = [];
  const logged = [];
  return {
    said,
    logged,
    sayPublic: (bot, line) => said.push({ bot, line }),
    journal: { log: (name, kind, text) => logged.push({ name, kind, text }) },
    bandFor: () => BAND_NEAR,
    rng: () => 0, // deterministic: first pool line, always passes chatterChance
    store: { announcedFriends: [], announcedInvites: [], announcedParties: [] },
    ...extra,
  };
}

function run(name, fn) {
  _resetForTests();
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// --- helpers -------------------------------------------------------------------

run("fillTemplate: substitutes vars, leaves unknown placeholders", () => {
  assert.equal(_fillTemplate("a {boss} b {n}", { boss: "X", n: 3 }), "a X b 3");
  assert.equal(_fillTemplate("{unknown}", {}), "{unknown}");
});

run("chatterChance: chatty high, gruff low, default mid", () => {
  assert.ok(_chatterChance({ traits: ["chatty"] }) > 0.5);
  assert.ok(_chatterChance({ traits: ["gruff"] }) < 0.5);
  assert.ok(_chatterChance({}) === 0.45);
});

run("bossLabelOf: null for unknown boss id (never invent)", () => {
  const bossById = (id) => (id === "giant_mole" ? { label: "the Giant Mole" } : null);
  assert.equal(_bossLabelOf(bossById, "giant_mole"), "the Giant Mole");
  assert.equal(_bossLabelOf(bossById, "dragon_king"), null);
  assert.equal(_bossLabelOf(bossById, null), null);
});

run("bossPartiesFor: dedupes by party id, leader-first, skips non-boss parties", () => {
  const leader = { username: "Mira" };
  const member = { username: "Tom" };
  const director = makeDirector([leader, member]);
  const party = { id: "p1", leader: "Mira", members: ["Mira", "Tom"], bossId: "giant_mole", phase: "travel" };
  const nonBoss = { id: "p2", leader: "Tom", members: ["Tom"], activity: "fishing" };
  const getParty = (name) => (name.toLowerCase() === "mira" ? party : nonBoss);
  const bossById = (id) => (id === "giant_mole" ? { label: "the Giant Mole" } : null);
  const out = _bossPartiesFor(director, [...director.roster.values()], getParty, bossById);
  assert.equal(out.length, 1, `expected 1 boss party, got ${out.length}`);
  assert.equal(out[0].party.id, "p1");
  assert.equal(out[0].leader.username, "Mira");
});

// --- boss-run chatter -----------------------------------------------------------

run("boss chatter: travel phase — leader states the real plan", () => {
  const player = makeRealPlayer();
  const { bot: leaderBot } = makeBot({ username: "Mira", locals: [player] });
  const { bot: compBot } = makeBot({ username: "Tom", locals: [player] });
  const director = makeDirector(
    [
      { username: "Mira", displayName: "Mira Swift" },
      { username: "Tom", displayName: "Tom" },
    ],
    (rec) => (rec.username === "Mira" ? leaderBot : compBot)
  );
  const party = {
    id: "p1", leader: "Mira", members: ["Mira", "Tom"], bossId: "giant_mole", phase: "travel",
  };
  const ov = makeOverrides({
    getParty: (name) => party,
    bossById: (id) => (id === "giant_mole" ? { label: "the Giant Mole" } : null),
  });
  tickBossGoalChatter(director, ov);
  // leader plan line + one companion chime
  assert.equal(ov.said.length, 2, `expected leader + chime, got ${ov.said.length}`);
  const [plan, chime] = ov.said.map((s) => s.line);
  assert.ok(plan.includes("the Giant Mole"), `plan names the real boss: "${plan}"`);
  assert.ok(plan.includes("2"), `plan names the real member count: "${plan}"`);
  assert.ok(chime.includes("Mira Swift"), `chime names the real leader: "${chime}"`);
  assert.ok(!ov.logged.some((l) => l.kind !== "social"), "travel chatter journals as social");
});

run("boss chatter: unknown boss id stays silent (never invent)", () => {
  const player = makeRealPlayer();
  const { bot } = makeBot({ username: "Mira", locals: [player] });
  const director = makeDirector([{ username: "Mira" }], () => bot);
  const party = {
    id: "p9", leader: "Mira", members: ["Mira"], bossId: "dragon_king", phase: "travel",
  };
  const ov = makeOverrides({
    getParty: () => party,
    bossById: () => null, // not a real boss
  });
  tickBossGoalChatter(director, ov);
  assert.equal(ov.said.length, 0, `expected silence, got ${JSON.stringify(ov.said)}`);
});

run("boss chatter: silent when no real player is nearby", () => {
  const { bot } = makeBot({ username: "Mira", locals: [] }); // unwatched
  const director = makeDirector([{ username: "Mira" }], () => bot);
  const party = {
    id: "p1", leader: "Mira", members: ["Mira"], bossId: "giant_mole", phase: "travel",
  };
  const ov = makeOverrides({
    getParty: () => party,
    bossById: (id) => ({ label: "the Giant Mole" }),
  });
  tickBossGoalChatter(director, ov);
  assert.equal(ov.said.length, 0, "unwatched parties don't narrate");
});

run("boss chatter: far LOD band stays silent", () => {
  const player = makeRealPlayer();
  const { bot } = makeBot({ username: "Mira", locals: [player] });
  const director = makeDirector([{ username: "Mira" }], () => bot);
  const party = {
    id: "p1", leader: "Mira", members: ["Mira"], bossId: "giant_mole", phase: "travel",
  };
  const ov = makeOverrides({
    getParty: () => party,
    bossById: (id) => ({ label: "the Giant Mole" }),
    bandFor: () => BAND_FAR,
  });
  tickBossGoalChatter(director, ov);
  assert.equal(ov.said.length, 0, "far LOD stays silent");
});

run("boss chatter: fight phase uses seen vs unseen pools from real party.bossSeen", () => {
  const player = makeRealPlayer();
  const { bot } = makeBot({ username: "Mira", locals: [player] });
  const director = makeDirector([{ username: "Mira" }], () => bot);
  const bossById = (id) => ({ label: "the Giant Mole" });

  const partySeen = { id: "p1", leader: "Mira", members: ["Mira"], bossId: "giant_mole", phase: "fight", bossSeen: true };
  const ov1 = makeOverrides({ getParty: () => partySeen, bossById, rng: () => 0 });
  tickBossGoalChatter(director, ov1);
  assert.equal(ov1.said.length, 1);
  assert.ok(ov1.said[0].line.includes("the Giant Mole is here"), `seen pool: "${ov1.said[0].line}"`);
  assert.equal(ov1.logged[0].kind, "combat", "fight chatter journals as combat");

  _resetForTests();
  const partyUnseen = { id: "p2", leader: "Mira", members: ["Mira"], bossId: "giant_mole", phase: "fight", bossSeen: false };
  const ov2 = makeOverrides({ getParty: () => partyUnseen, bossById, rng: () => 0 });
  tickBossGoalChatter(director, ov2);
  assert.equal(ov2.said.length, 1);
  assert.ok(/where IS this thing/i.test(ov2.said[0].line), `unseen pool: "${ov2.said[0].line}"`);
});

run("boss chatter: per-party throttle — plan line fires once per party", () => {
  const player = makeRealPlayer();
  const { bot } = makeBot({ username: "Mira", locals: [player] });
  const director = makeDirector([{ username: "Mira" }], () => bot);
  const party = {
    id: "p1", leader: "Mira", members: ["Mira"], bossId: "giant_mole", phase: "travel",
  };
  const ov = makeOverrides({
    getParty: () => party,
    bossById: (id) => ({ label: "the Giant Mole" }),
    nowMs: 1_000_000,
  });
  tickBossGoalChatter(director, ov);
  assert.equal(ov.said.length, 1);
  tickBossGoalChatter(director, { ...ov, said: ov.said, nowMs: 1_000_000 + 60_000 });
  assert.equal(ov.said.length, 1, "second tick within cooldown stays silent");
  assert.ok(_nextPartyChatterAt.get("p1") > 1_000_000, "cooldown set for the party");
});

// --- friend-making chatter -------------------------------------------------------

run("friend chatter: pending clan invite mentioned once per invite id", () => {
  const player = makeRealPlayer();
  const { bot } = makeBot({ username: "Mira", locals: [player] });
  const director = makeDirector([{ username: "Mira" }], () => bot);
  const invite = {
    id: "inv_1", kind: "clan_invite", from: "tom", fromDisplay: "Tom",
    to: "mira", createdAt: 0, expiresAt: Date.now() + 600_000, data: {},
  };
  const ov = makeOverrides({
    getInvites: () => [invite],
    bonds: () => ({ friends: [] }),
    getParty: () => null,
  });
  tickFriendGoalChatter(director, ov);
  assert.equal(ov.said.length, 1, `expected one invite line, got ${ov.said.length}`);
  assert.ok(ov.said[0].line.includes("Tom"), `invite names the real sender: "${ov.said[0].line}"`);
  assert.ok(/clan/i.test(ov.said[0].line), `invite names the clan kind: "${ov.said[0].line}"`);
  assert.ok(ov.store.announcedInvites.includes("inv_1"), "invite id recorded");

  // second tick: same invite id is not re-announced
  tickFriendGoalChatter(director, { ...ov, nowMs: 1_000_000 });
  assert.equal(ov.said.length, 1, "invite mentioned only once");
});

run("friend chatter: unknown invite kind stays silent", () => {
  const player = makeRealPlayer();
  const { bot } = makeBot({ username: "Mira", locals: [player] });
  const director = makeDirector([{ username: "Mira" }], () => bot);
  const invite = {
    id: "inv_9", kind: "mystery_kind", from: "tom", fromDisplay: "Tom",
    to: "mira", createdAt: 0, expiresAt: Date.now() + 600_000, data: {},
  };
  const ov = makeOverrides({
    getInvites: () => [invite],
    bonds: () => ({ friends: [] }),
    getParty: () => null,
  });
  tickFriendGoalChatter(director, ov);
  assert.equal(ov.said.length, 0, "unknown invite kinds never speak");
});

run("friend chatter: existing friends seeded, only NEW friendships announced", () => {
  const player = makeRealPlayer();
  const { bot } = makeBot({ username: "Mira", locals: [player] });
  const director = makeDirector(
    [{ username: "Mira" }, { username: "Old pal", displayName: "Oldpal" }],
    () => bot
  );
  // Mira already has a friend before first tick — seeding must NOT announce it.
  const friends = { mira: ["Old pal"] };
  const ov = makeOverrides({
    getInvites: () => [],
    bonds: (name) => ({ friends: friends[name.toLowerCase()] ?? [] }),
    getParty: () => null,
  });
  tickFriendGoalChatter(director, ov);
  assert.equal(ov.said.length, 0, "old friendships are seeded, not announced");
  assert.ok(ov.store.announcedFriends.some((k) => k.startsWith("mira|")), "seed recorded");

  // A genuinely new friend appears -> announced once, naming them.
  friends.mira.push("Newfriend");
  _nextFriendChatterAt.delete("mira"); // lift the per-citizen cooldown only
  tickFriendGoalChatter(director, { ...ov, nowMs: 5_000_000 });
  assert.equal(ov.said.length, 1, `expected one new-friend line, got ${ov.said.length}`);
  assert.ok(/newfriend/i.test(ov.said[0].line), `announces the new friend: "${ov.said[0].line}"`);
  assert.ok(ov.store.announcedFriends.some((k) => k.endsWith("|newfriend")), "new friend persisted");

  // third tick: announced already -> silence
  _nextFriendChatterAt.delete("mira");
  tickFriendGoalChatter(director, { ...ov, nowMs: 6_000_000 });
  assert.equal(ov.said.length, 1, "new friendship announced exactly once");
});

run("friend chatter: running with a friend — real party + real friendship named", () => {
  const player = makeRealPlayer();
  const { bot } = makeBot({ username: "Mira", locals: [player] });
  const director = makeDirector(
    [{ username: "Mira" }, { username: "Tom", displayName: "Tom" }],
    () => bot
  );
  const party = {
    id: "bp7", leader: "Mira", members: ["Mira", "Tom"], bossId: "giant_mole", phase: "travel",
  };
  const ov = makeOverrides({
    getInvites: () => [],
    bonds: () => ({ friends: [] }),
    getParty: () => party,
    isFriend: (a, b) =>
      (a.toLowerCase() === "mira" && b.toLowerCase() === "tom") ||
      (a.toLowerCase() === "tom" && b.toLowerCase() === "mira"),
    bossById: (id) => ({ label: "the Giant Mole" }),
  });
  tickFriendGoalChatter(director, ov);
  assert.equal(ov.said.length, 1, `expected one line, got ${ov.said.length}`);
  assert.ok(ov.said[0].line.includes("Tom"), `names the real friend: "${ov.said[0].line}"`);
  assert.ok(/giant mole/i.test(ov.said[0].line), `names the real activity: "${ov.said[0].line}"`);
  assert.ok(ov.store.announcedParties.includes("party:bp7"), "party id recorded once");

  // second tick: same party not re-announced
  tickFriendGoalChatter(director, { ...ov, nowMs: 3_000_000 });
  assert.equal(ov.said.length, 1, "party-with-friend mentioned only once");
});

run("friend chatter: party without a friend stays silent", () => {
  const player = makeRealPlayer();
  const { bot } = makeBot({ username: "Mira", locals: [player] });
  const director = makeDirector([{ username: "Mira" }, { username: "Tom" }], () => bot);
  const party = { id: "bp8", leader: "Mira", members: ["Mira", "Tom"], phase: "travel" };
  const ov = makeOverrides({
    getInvites: () => [],
    bonds: () => ({ friends: [] }),
    getParty: () => party,
    isFriend: () => false,
  });
  tickFriendGoalChatter(director, ov);
  assert.equal(ov.said.length, 0, "no friend in party -> silence");
});

run("friend chatter: per-citizen throttle after one line", () => {
  const player = makeRealPlayer();
  const { bot } = makeBot({ username: "Mira", locals: [player] });
  const director = makeDirector([{ username: "Mira" }], () => bot);
  const inv1 = {
    id: "inv_a", kind: "friend_request", from: "zed", fromDisplay: "Zed",
    to: "mira", createdAt: 0, expiresAt: Date.now() + 600_000, data: {},
  };
  const inv2 = {
    id: "inv_b", kind: "friend_request", from: "amy", fromDisplay: "Amy",
    to: "mira", createdAt: 0, expiresAt: Date.now() + 600_000, data: {},
  };
  const ov = makeOverrides({
    getInvites: () => [inv1, inv2],
    bonds: () => ({ friends: [] }),
    getParty: () => null,
    nowMs: 4_000_000,
  });
  tickFriendGoalChatter(director, ov);
  assert.equal(ov.said.length, 1, "one line per tick");
  tickFriendGoalChatter(director, { ...ov, nowMs: 4_000_000 + 60_000 });
  assert.equal(ov.said.length, 1, "throttled even with a second fresh invite");
  assert.ok(_nextFriendChatterAt.get("mira") > 4_000_000, "citizen cooldown set");
});
