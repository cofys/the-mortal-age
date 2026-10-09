"use strict";

// CitizenGuildInvites unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  shouldInvite,
  canReAsk,
  inviteHistory,
  flavorFor,
  invitationLine,
  pickOne,
  pendingKey,
  eligibleGuild,
  peekPendingInvite,
  INVITE_LINES,
  GUILD_INVITE_CITIZEN_COOLDOWN_MS,
  GUILD_INVITE_CHANCE,
  GUILD_INVITE_DECLINE_REASK_MS,
} = require("./CitizenGuildInvites");
const Registry = require("../../guilds/GuildRegistry");
const Bonds = require("./CitizenBonds");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// --- shouldInvite: cooldown + chance ---
check("shouldInvite blocks within the cooldown", () => {
  const now = 1_000_000_000;
  assert.equal(shouldInvite(() => 0.01, now - 60 * 1000, now), false); // 1 min ago
  assert.equal(shouldInvite(() => 0.01, now - GUILD_INVITE_CITIZEN_COOLDOWN_MS + 1, now), false);
});

check("shouldInvite honors the chance gate after cooldown", () => {
  const now = 1_000_000_000;
  const last = now - GUILD_INVITE_CITIZEN_COOLDOWN_MS - 1;
  assert.equal(shouldInvite(() => 0.05, last, now), true); // under chance
  assert.equal(shouldInvite(() => 0.5, last, now), false); // over chance
  assert.equal(shouldInvite(() => 0.01, 0, now), true); // never invited
});

// --- canReAsk: 7-day no-nag window after a decline ---
check("canReAsk is true with no decline recorded", () => {
  assert.equal(canReAsk({}, "cit", "plr", Date.now()), true);
});

check("canReAsk blocks a recent decline, allows an old one", () => {
  const now = 1_000_000_000;
  const key = pendingKey("Cit", "Plr");
  assert.equal(canReAsk({ [key]: now - 24 * 3600 * 1000 }, "cit", "plr", now), false); // 1 day ago
  assert.equal(canReAsk({ [key]: now - 8 * 24 * 3600 * 1000 }, "cit", "plr", now), true); // 8 days ago
  assert.equal(
    canReAsk({ [key]: now - GUILD_INVITE_DECLINE_REASK_MS + 1 }, "cit", "plr", now),
    false
  ); // just inside
});

check("canReAsk is per citizen-player pair", () => {
  const now = 1_000_000_000;
  const declines = { [pendingKey("cit", "plr")]: now - 1000 };
  assert.equal(canReAsk(declines, "other", "plr", now), true);
  assert.equal(canReAsk(declines, "cit", "other", now), true);
});

// --- inviteHistory: outcome counting from memory moments ---
check("inviteHistory counts accepted and declined guild invites", () => {
  const moments = [
    { text: "joined my guild 'Iron Oath'" },
    { text: "turned down my guild invitation to 'Iron Oath'" },
    { text: "ignored my guild invitation to 'Iron Oath'" },
    { text: "joined me for a fishing trip" }, // unrelated — must not count
    { text: "met a stranger on the road" }, // unrelated
  ];
  assert.deepEqual(inviteHistory(moments), { accepted: 1, declined: 2 });
});

check("inviteHistory handles empty/undefined", () => {
  assert.deepEqual(inviteHistory([]), { accepted: 0, declined: 0 });
  assert.deepEqual(inviteHistory(undefined), { accepted: 0, declined: 0 });
});

// --- flavorFor: first / warm / wistful ---
check("flavorFor picks first/warm/wistful", () => {
  assert.equal(flavorFor({ accepted: 0, declined: 0 }), "first");
  assert.equal(flavorFor({ accepted: 1, declined: 0 }), "warm");
  assert.equal(flavorFor({ accepted: 3, declined: 1 }), "warm");
  assert.equal(flavorFor({ accepted: 0, declined: 2 }), "wistful");
  assert.equal(flavorFor({ accepted: 1, declined: 3 }), "wistful");
  assert.equal(flavorFor({ accepted: 0, declined: 1 }), "first"); // single decline isn't wistful yet
});

// --- invitationLine: guild name in the line, flavored ---
check("invitationLine names the guild and is deterministic per seed", () => {
  const a = invitationLine(lcg(42), "Iron Oath", "first");
  const b = invitationLine(lcg(42), "Iron Oath", "first");
  assert.equal(a, b);
  assert.match(a, /Iron Oath/);
});

check("spoken lines fit the 80-char overhead limit", () => {
  const guild = "Iron Oath 12"; // 12-char guild name
  for (const flavor of ["first", "warm", "wistful"]) {
    for (let s = 0; s < 20; s++) {
      const line = invitationLine(lcg(s), guild, flavor);
      assert.ok(line.length <= 80, `too long (${line.length}): ${line}`);
    }
  }
});

check("invitationLine flavors warm and wistful", () => {
  const warm = invitationLine(lcg(7), "Iron Oath", "warm");
  assert.match(warm, /Iron Oath/);
  const wistful = invitationLine(lcg(7), "Iron Oath", "wistful");
  assert.match(wistful, /Iron Oath/);
  assert.notEqual(warm, wistful);
});

// --- pickOne deterministic ---
check("pickOne is deterministic with the same rng", () => {
  const arr = ["a", "b", "c", "d"];
  assert.equal(pickOne(lcg(9), arr), pickOne(lcg(9), arr));
});

// --- pendingKey normalization ---
check("pendingKey normalizes names", () => {
  assert.equal(pendingKey("Bob", "Liam"), pendingKey("bob", "liam"));
});

// --- peekPendingInvite: nothing tracked -> null ---
check("peekPendingInvite returns null when nothing was sent", () => {
  assert.equal(peekPendingInvite("definitely-not-a-player-xyz", "guild_x"), null);
});

// --- eligibleGuild: the full selection gate ---
// Patch the Registry read functions so no save files are touched.
const origMemberGuild = Registry.memberGuild;
const origPending = Registry.pendingInvitesFor;
Registry.memberGuild = () => null;
Registry.pendingInvitesFor = () => [];

const OFFICER_GUILD = {
  id: "g1",
  name: "Iron Oath",
  members: { testcit7: { rank: Registry.RANK_OFFICER } },
};
const MEMBER_GUILD = {
  id: "g2",
  name: "Iron Oath",
  members: { testcit7: { rank: Registry.RANK_MEMBER } },
};

Bonds.addFriend("testcit7", "guitestplr7");

check("eligibleGuild returns the guild for an officer friend", () => {
  const g = eligibleGuild("testcit7", OFFICER_GUILD, "guitestplr7", { declines: {}, nowMs: 1_000_000_000 });
  assert.equal(g, OFFICER_GUILD);
});

check("eligibleGuild rejects non-officers", () => {
  assert.equal(
    eligibleGuild("testcit7", MEMBER_GUILD, "guitestplr7", { declines: {}, nowMs: 1_000_000_000 }),
    null
  );
});

check("eligibleGuild rejects non-friends", () => {
  assert.equal(
    eligibleGuild("strangercit7", OFFICER_GUILD, "guitestplr7", { declines: {}, nowMs: 1_000_000_000 }),
    null
  );
});

check("eligibleGuild rejects a recent decliner", () => {
  const now = 1_000_000_000;
  const declines = { [pendingKey("testcit7", "guitestplr7")]: now - 1000 };
  assert.equal(eligibleGuild("testcit7", OFFICER_GUILD, "guitestplr7", { declines, nowMs: now }), null);
});

check("eligibleGuild rejects a player already in a guild", () => {
  Registry.memberGuild = () => ({ id: "other" });
  try {
    assert.equal(
      eligibleGuild("testcit7", OFFICER_GUILD, "guitestplr7", { declines: {}, nowMs: 1_000_000_000 }),
      null
    );
  } finally {
    Registry.memberGuild = () => null;
  }
});

check("eligibleGuild rejects a player with pending invites", () => {
  Registry.pendingInvitesFor = () => [{ guildId: "g9", guildName: "Other" }];
  try {
    assert.equal(
      eligibleGuild("testcit7", OFFICER_GUILD, "guitestplr7", { declines: {}, nowMs: 1_000_000_000 }),
      null
    );
  } finally {
    Registry.pendingInvitesFor = () => [];
  }
});

// Restore patched Registry functions and clean the test bond (no save flushed).
Registry.memberGuild = origMemberGuild;
Registry.pendingInvitesFor = origPending;
Bonds.removeFriend("testcit7", "guitestplr7");

// --- tuning constant sanity ---
check("cooldown is 2 hours", () => {
  assert.equal(GUILD_INVITE_CITIZEN_COOLDOWN_MS, 2 * 60 * 60 * 1000);
});

check("decline re-ask window is 7 days", () => {
  assert.equal(GUILD_INVITE_DECLINE_REASK_MS, 7 * 24 * 60 * 60 * 1000);
});

check("invite chance is low (not spammy)", () => {
  assert.ok(GUILD_INVITE_CHANCE <= 0.2, `chance ${GUILD_INVITE_CHANCE} too high`);
});

console.log(`\n${passed} assertions passed.`);
