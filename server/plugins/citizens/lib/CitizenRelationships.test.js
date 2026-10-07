// CitizenRelationships + memory-moment unit checks — pure logic, no server.
// From server/plugins/citizens: node lib/CitizenRelationships.test.js (plain node)
const assert = require("node:assert/strict");
const { getMemory, MOMENT_HELPED, MOMENT_BETRAYED, relativeTime } = require("./CitizenMemory");
const { addFriend, isFriend, sendInvite } = require("./CitizenBonds");
const { getJournal } = require("./CitizenJournal");
const {
  onFriendLogin,
  onFriendLogout,
  warnFriends,
  tickRelationships,
  resetForTests,
  GREET_FRIEND_COOLDOWN_MS,
} = require("./CitizenRelationships");

const memory = getMemory();
memory.resetForTests();
getJournal().resetForTests();
resetForTests();

// --- relative time ---
assert.equal(relativeTime(1000, 1000 + 30 * 1000), "just now");
assert.equal(relativeTime(0, 5 * 60000), "5 minutes ago");
assert.equal(relativeTime(0, 2 * 3600000), "2 hours ago");
assert.equal(relativeTime(0, 26 * 3600000), "yesterday");
assert.equal(relativeTime(0, 3 * 86400000), "3 days ago");
assert.equal(relativeTime(0, 9 * 86400000), "last week");
assert.equal(relativeTime(0, 21 * 86400000), "3 weeks ago");

// --- moments ---
{
  const m = memory;
  m.recordMeeting("Maren", "Dave", 1000);
  const entry = m.getEntry("Maren", "Dave");
  assert.equal(entry.moments.length, 1, "first meeting auto-records a moment");
  assert.equal(entry.moments[0].kind, "met");

  m.recordMoment("Maren", "Dave", MOMENT_HELPED, "helped me carry the lumber", {}, 2000);
  assert.equal(m.getEntry("Maren", "Dave").moments.length, 2);

  // Dedupe: same text within a day is ignored.
  m.recordMoment("Maren", "Dave", MOMENT_HELPED, "helped me carry the lumber", {}, 3000);
  assert.equal(m.getEntry("Maren", "Dave").moments.length, 2, "duplicate moment ignored");

  // Bound: oldest non-pinned drop off past MAX_MOMENTS.
  for (let i = 0; i < 12; i += 1) {
    m.recordMoment("Maren", "Dave", MOMENT_HELPED, `deed ${i}`, {}, 4000 + i);
  }
  const after = m.getEntry("Maren", "Dave").moments;
  assert.ok(after.length <= 10, `moments bounded, got ${after.length}`);

  // Pinned moments survive eviction.
  m.recordMoment("Maren", "Zoe", MOMENT_BETRAYED, "attacked me", { pinned: true }, 5000);
  for (let i = 0; i < 12; i += 1) {
    m.recordMoment("Maren", "Zoe", MOMENT_HELPED, `kindness ${i}`, {}, 6000 + i);
  }
  const zoe = m.getEntry("Maren", "Zoe").moments;
  assert.ok(zoe.some((x) => x.pinned), "pinned moment survives");
  assert.ok(zoe.length <= 10, "still bounded with pinned");

  // Grudge auto-records a betrayed moment.
  m.addGrudge("Maren", "Eve", 3, "attack", 7000);
  const eve = m.getEntry("Maren", "Eve").moments;
  assert.ok(eve.some((x) => x.kind === MOMENT_BETRAYED), "attack auto-momented");
  assert.ok(eve.some((x) => x.pinned), "severity-3 moment pinned");

  // Generosity tier crossing auto-records.
  m.recordSpend("Maren", "Rich", 1500, 8000);
  const rich = m.getEntry("Maren", "Rich").moments;
  assert.ok(rich.some((x) => x.kind === "generous"), "generosity auto-momented");

  // momentLine renders with relative time.
  const line = m.momentLine("Maren", "Dave", 4000 + 11 + 2 * 86400000);
  assert.ok(line && line.includes("You remember"), "moment line has voice");
  assert.ok(line.includes("days ago"), "moment line has relative time");

  // opinionLine per standing.
  m.recordMeeting("Maren", "Pal", 9000);
  m.recordMeeting("Maren", "Pal", 9001);
  m.recordMeeting("Maren", "Pal", 9002);
  assert.ok(m.opinionLine("Maren", "Pal", 9002).includes("fondly"), "regular opinion");
  const hostile = m.opinionLine("Maren", "Eve", 9002);
  assert.ok(hostile.includes("despise") && hostile.includes("attacked me"), "hostile opinion names the deed");
  assert.equal(m.opinionLine("Maren", "Stranger", 9002), null, "no opinion of strangers");
  assert.equal(m.momentLine("Maren", "Stranger", 9002), null, "no recall for strangers");
}

// --- relationships: login/logout/warn/tick ---
function mockPlayer(name, sent) {
  return {
    getUsername: () => name,
    isPlayerBot: () => false,
    getHostAddress: () => "1.2.3.4",
    sendMessage: (msg) => sent.push(msg),
  };
}

{
  // Friend login: friend citizens greet.
  const sent = [];
  const player = mockPlayer("Aldric", sent);
  addFriend("Mira", "Aldric");
  const director = {
    roster: new Map([["mira", { username: "Mira", displayName: "Mira" }]]),
    isOnline: () => true,
    getBot: () => null,
  };
  const greeted = onFriendLogin(director, player, 10000);
  assert.equal(greeted, 1, "friend citizen greets on login");
  assert.ok(sent.some((s) => s.includes("missed you")), "greeting says they missed them");

  // Logout: journaled missing.
  const missed = onFriendLogout(director, player, 11000);
  assert.equal(missed, 1, "friend citizen misses them on logout");
  const recent = getJournal().recent("Mira", 3).map((e) => e.text).join(" ");
  assert.ok(recent.includes("miss"), "logout journaled as missing");

  // warnFriends: only severity >= 2, bounded to 2 friends.
  const warned = warnFriends("Mira", "Villain", "attack", 3, 12000);
  assert.ok(warned >= 1, "friends warned on severe offense");
  assert.equal(warnFriends("Mira", "Villain", "attack", 1, 12000), 0, "severity 1 not warned");

  // tick: nearby friend hailed by name, cooldown enforced.
  resetForTests();
  const forceChatted = [];
  const bot = {
    getLocalPlayers: () => [player],
    forceChat: (line) => forceChatted.push(line),
  };
  const d2 = {
    roster: new Map([["mira", { username: "Mira", displayName: "Mira", personality: { traits: ["chatty"] } }]]),
    isOnline: () => true,
    getBot: () => bot,
  };
  // Sweep forward minute-by-minute until a hail fires (RNG-gated per minute).
  let t0 = -1;
  for (let i = 0; i < 120 && t0 < 0; i += 1) {
    tickRelationships(d2, 20000 + i * 61000);
    if (forceChatted.length > 0) t0 = 20000 + i * 61000;
  }
  assert.ok(t0 >= 0, "friend hailed by name within 120 minutes");
  assert.ok(forceChatted.some((l) => l.includes("Aldric")), "hail uses the player's name");
  forceChatted.length = 0;
  tickRelationships(d2, t0 + 60000);
  assert.equal(forceChatted.length, 0, "cooldown blocks repeat hail");
  // After the cooldown window, hails resume (sweep again for the RNG gate).
  let resumed = false;
  for (let i = 0; i < 120 && !resumed; i += 1) {
    tickRelationships(d2, t0 + GREET_FRIEND_COOLDOWN_MS + 61000 + i * 61000);
    resumed = forceChatted.length > 0;
  }
  assert.ok(resumed, "hail resumes after cooldown");
}

console.log("CitizenRelationships.test.js: all checks passed");
