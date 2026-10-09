"use strict";

// Citizen invite flows: boss-run invites and clan invites, end to end at the
// data layer. Plain node, no running server.

const assert = require("node:assert/strict");

const Mech = require("./CitizenSocialMechanics");
const Bonds = require("./CitizenBonds");
const Clans = require("./CitizenClans");
const PlayerActivities = require("./CitizenPlayerActivities");
const { getJournal } = require("./CitizenJournal");

let passed = 0;
function check(name, fn) {
  Clans.resetForTests();
  try {
    getJournal().resetForTests();
  } catch {
    // Non-fatal.
  }
  try {
    fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

function playerMock(name, sent = []) {
  return {
    getUsername: () => name,
    isPlayerBot: () => false,
    sendMessage: (m) => sent.push(m),
  };
}

// --- boss-run invite flow ---------------------------------------------------------

check("boss-run invite: brave citizen invites friend player, player accepts", () => {
  const sent = [];
  // tickCitizen's rng is seeded per citizen per ~65s bucket, so a tight
  // loop with one name replays the same draws. Rotate names for
  // independent draws (each still a brave citizen with a friend player).
  const player = playerMock("PlayerPal", sent);
  const bot = { getAttribute: () => ({ traits: ["brave"] }) };
  let invite = null;
  let inviter = null;
  for (let i = 0; i < 500 && !invite; i++) {
    const uname = `BossBritt${i}`;
    const record = {
      username: uname,
      displayName: uname,
      personality: { traits: ["brave", "outgoing"] },
      hasClanChannel: true, // skip the channel-creation branch
    };
    Bonds.addFriend(uname, "PlayerPal");
    Bonds.addFriend("PlayerPal", uname);
    Mech.tickCitizen(record, () => bot, [player]);
    invite = Bonds.getInvites("PlayerPal").find(
      (x) => x.kind === Bonds.INVITE_BOSS && x.from === uname.toLowerCase()
    );
    if (invite) inviter = uname;
  }
  assert.ok(invite, "brave citizen should eventually invite a friend on a boss trip");
  assert.ok(
    sent.some((m) => /boss trip/i.test(m)),
    "player should be notified of the boss-trip invite"
  );

  // The player says "yes" -> acceptInvite resolves + citizen follows them.
  const result = Mech.acceptInvite("PlayerPal", inviter, Bonds.INVITE_BOSS);
  assert.ok(result, "invite should resolve");
  const follow = Bonds.getFollow(inviter.toLowerCase());
  assert.ok(follow, "citizen should follow the player");
  assert.equal(follow.target, "playerpal");
  assert.equal(follow.reason, "boss_trip");
  const recent = getJournal().recent(inviter, 5).map((e) => e.text).join(" ");
  assert.ok(/boss trip/i.test(recent), `journal should note the trip, got: ${recent}`);
});

check("boss-run invite: enemies never get invited", () => {
  const sent = [];
  const record = {
    username: "BossBoris",
    displayName: "BossBoris",
    personality: { traits: ["brave"] },
    hasClanChannel: true,
  };
  const bot = { getAttribute: () => ({ traits: ["brave"] }) };
  const player = playerMock("EnemyErin", sent);
  Bonds.addEnemy("BossBoris", "EnemyErin");

  for (let i = 0; i < 300; i++) {
    Mech.tickCitizen(record, () => bot, [player]);
  }
  const invite = Bonds.getInvites("EnemyErin").find(
    (x) => x.kind === Bonds.INVITE_BOSS && x.from === "bossboris"
  );
  assert.equal(invite, undefined, "enemies must not receive boss-trip invites");
});

// --- activity invite flow (citizen boss-run party -> nearby players) ------------------

check("offerActivityToPlayers: friends first, enemies excluded", () => {
  const sentPal = [];
  const sentStranger = [];
  const sentEnemy = [];
  const pal = playerMock("FriendFay", sentPal);
  const stranger = playerMock("StrangerSam", sentStranger);
  const enemy = playerMock("EnemyNed", sentEnemy);
  const bot = {
    getAttribute: () => ({ traits: ["chatty"] }),
    getLocalPlayers: () => [pal, stranger, enemy],
  };
  const director = {
    getBot: () => bot,
    roster: new Map([["partypete", {}]]),
    isOnline: () => true,
  };
  const record = { username: "PartyPete", displayName: "PartyPete" };
  const party = { id: "party_1", leader: "PartyPete", members: ["PartyPete"] };
  Bonds.addFriend("PartyPete", "FriendFay");
  Bonds.addFriend("FriendFay", "PartyPete");
  Bonds.addEnemy("PartyPete", "EnemyNed");

  const invited = PlayerActivities.offerActivityToPlayers(director, record, party, {
    activityId: "boss_run",
    label: "boss run",
    formLines: ["Mole run forming — who's in?"],
  });

  assert.ok(invited.includes("FriendFay"), "friend should be invited");
  assert.ok(invited.includes("StrangerSam"), "stranger should be invited");
  assert.ok(!invited.includes("EnemyNed"), "enemy must be excluded");
  assert.equal(invited[0], "FriendFay", "friends sort before strangers");
  const invites = Bonds.getInvites("FriendFay");
  assert.ok(
    invites.some((i) => i.kind === Bonds.INVITE_ACTIVITY && i.data.activityId === "boss_run"),
    "invite record should carry the activity"
  );
  assert.ok(sentPal.some((m) => /boss run/i.test(m)), "friend notified");
});

// --- clan invite accept path (player says "yes" in chat) --------------------------------

check("clan invite: player accepts via acceptInvite and joins the clan", () => {
  const clan = Clans.createClan("ClanCarl", "ClanCarl", "varrock", Clans.KIND_SOCIAL);
  assert.ok(clan);
  const id = Clans.invitePlayer("ClanCarl", "RealPlayerTwo", clan.id);
  assert.ok(id, "invite sent");
  const result = Mech.acceptInvite("RealPlayerTwo", "ClanCarl", Bonds.INVITE_CLAN);
  assert.ok(result, "invite should resolve");
  assert.equal(Clans.clanOfPlayer("RealPlayerTwo")?.id, clan.id, "player joins the clan");
  assert.equal(
    Bonds.getInvites("RealPlayerTwo").filter((i) => i.kind === Bonds.INVITE_CLAN).length,
    0,
    "invite consumed"
  );
});

check("clan channel invite: player accepts a citizen's channel invite", () => {
  const sent = [];
  const player = playerMock("ChanFan", sent);
  const bot = { getAttribute: () => ({ traits: ["outgoing"] }) };
  // Same seed-rotation trick as the boss-invite check above.
  let invite = null;
  let inviter = null;
  for (let i = 0; i < 500 && !invite; i++) {
    const uname = `ChanChad${i}`;
    const record = {
      username: uname,
      displayName: uname,
      personality: { traits: ["outgoing"] },
      hasClanChannel: true,
    };
    Bonds.addFriend(uname, "ChanFan");
    Bonds.addFriend("ChanFan", uname);
    Mech.tickCitizen(record, () => bot, [player]);
    invite = Bonds.getInvites("ChanFan").find(
      (x) => x.kind === Bonds.INVITE_CLAN && x.from === uname.toLowerCase()
    );
    if (invite) inviter = uname;
  }
  assert.ok(invite, "citizen should eventually invite a friend to their clan channel");
  assert.ok(sent.some((m) => /clan chat/i.test(m)), "player notified of channel invite");
  const result = Mech.acceptInvite("ChanFan", inviter, Bonds.INVITE_CLAN);
  assert.ok(result, "channel invite resolves");
});

console.log(`\n${passed} checks passed.`);
