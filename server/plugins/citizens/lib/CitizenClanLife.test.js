// CitizenClanLife unit checks — tick dynamics with stubbed engine deps.
const assert = require("node:assert/strict");
const path = require("node:path");

// Stub BotNavigation (lazy-required inside moveBot) before loading ClanLife.
const navPath = require.resolve("../../bots/behaviours/navigation/BotNavigation");
const navCalls = [];
require.cache[navPath] = {
  exports: {
    requestMovement: (bot, x, y, opts) => {
      navCalls.push({ bot, x, y, opts });
      return true;
    },
    peekMovementRequest: () => null,
    dispatchMovementRequest: () => ({ hasRoute: true }),
    clearMovementRequest: () => {},
  },
};

// Stub sayPublic to capture speech.
const sayPath = require.resolve("../chat/CitizenSayPublic");
const said = [];
require.cache[sayPath] = {
  exports: { sayPublic: (bot, text) => { said.push(String(text)); return true; } },
};

const Clans = require("./CitizenClans");
const Bonds = require("./CitizenBonds");
const SocialBonds = require("./CitizenSocialBonds");
const { getJournal } = require("./CitizenJournal");
const Life = require("./CitizenClanLife");

const always = () => 0; // rng: every chance() passes
const never = () => 0.999999; // rng: every chance() fails
// Sequenced rng: first pickOne -> members[0], second pickOne -> members[1],
// then 0 (chance always passes).
function seq() {
  const vals = [0, 0.6, 0];
  let i = 0;
  return () => vals[(i++) % vals.length];
}

function rec(username, role = "commoner", kingdomId = "varrock", goalType = null, traits = []) {
  return {
    username,
    displayName: username,
    role,
    kingdomId,
    goal: goalType ? { type: goalType } : null,
    personality: { traits },
  };
}

function fakeBot(username, x = 3000, y = 3000, z = 0) {
  let following = null;
  return {
    getUsername: () => username,
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }),
    getMovementQueue: () => ({ size: () => 0 }),
    setFollowing: (t) => { following = t; },
    getFollowing: () => following,
  };
}

function fakeDirector(records, onlineNames) {
  const roster = new Map();
  for (const r of records) roster.set(r.username.toLowerCase(), r);
  const bots = new Map();
  for (const n of onlineNames ?? []) {
    const r = roster.get(String(n).toLowerCase());
    if (r) bots.set(String(n).toLowerCase(), fakeBot(r.username));
  }
  return {
    roster,
    api: null,
    getBot: (record) => bots.get(String(record?.username ?? "").toLowerCase()) ?? null,
    isOnline: (record) => bots.has(String(record?.username ?? "").toLowerCase()),
    _bots: bots,
  };
}

function befriend(a, b) {
  Bonds.addFriend(a, b);
  Bonds.addFriend(b, a);
}

// Player-facing messages (notifyPlayer) captured here.
const sentToPlayer = [];

// Director variant where named real players are online: World.getPlayerByName
// resolves them, everyone else is offline.
function onlineDirector(records, playerNames, botNames) {
  const d = fakeDirector(records, botNames ?? []);
  const online = new Map((playerNames ?? []).map((n) => [String(n).toLowerCase(), n]));
  d.api = {
    core: {
      World: {
        getPlayerByName: (name) => {
          const key = String(name ?? "").toLowerCase();
          if (!online.has(key)) return null;
          return {
            getUsername: () => online.get(key),
            sendMessage: (t) => {
              sentToPlayer.push({ to: online.get(key), text: String(t) });
            },
          };
        },
      },
    },
  };
  return d;
}

// Five favors = +40 bond score (favor weight 8), reaching FRIEND_AT.
function bondToFriend(owner, target, storyPrefix) {
  for (let i = 0; i < 5; i++) {
    SocialBonds.recordFavor(owner, target, `${storyPrefix} ${i}.`);
  }
}

let passed = 0;
function check(name, fn) {
  Clans.resetForTests();
  SocialBonds.resetForTests();
  getJournal().resetForTests();
  said.length = 0;
  navCalls.length = 0;
  sentToPlayer.length = 0;
  fn();
  passed++;
  console.log("ok - " + name);
}

// --- formation ------------------------------------------------------------------

check("maybeFoundClan founds and seeds mutual friends", () => {
  const founder = rec("ClanFounderA", "commoner", "varrock", "master_trade", ["outgoing"]);
  const f1 = rec("ClanFriend1", "commoner", "varrock", "master_trade", []);
  const f2 = rec("ClanFriend2", "commoner", "varrock", "master_trade", []);
  const f3 = rec("ClanFriend3", "commoner", "varrock", null, []);
  const d = fakeDirector([founder, f1, f2, f3], ["ClanFounderA"]);
  befriend("ClanFounderA", "ClanFriend1");
  befriend("ClanFounderA", "ClanFriend2");
  befriend("ClanFounderA", "ClanFriend3");
  const ok = Life.maybeFoundClan(d, founder, always);
  assert.equal(ok, true);
  const clan = Clans.clanOf("ClanFounderA");
  assert.ok(clan);
  assert.equal(clan.kind, Clans.KIND_CRAFT);
  assert.ok((clan.members?.length ?? 0) >= 2, "friends joined");
  assert.ok(said.length > 0, "founder announced");
});

check("maybeFoundClan does nothing when chance fails or ineligible", () => {
  const founder = rec("ClanFounderB", "commoner", "varrock", null, ["outgoing"]);
  const d = fakeDirector([founder], ["ClanFounderB"]);
  assert.equal(Life.maybeFoundClan(d, founder, never), false);
  assert.equal(Clans.clanCount(), 0);
  const shy = rec("ShyFounder", "commoner", "varrock", null, ["taciturn"]);
  const d2 = fakeDirector([shy], ["ShyFounder"]);
  befriend("ShyFounder", "ClanFriend1");
  assert.equal(Life.maybeFoundClan(d2, shy, always), false);
});

// --- growth -----------------------------------------------------------------------

check("maybeGrowClan invites a member's friend", () => {
  const founder = rec("GrowFounder", "commoner", "varrock", null, ["outgoing"]);
  const d = fakeDirector([founder, rec("GrowPal", "commoner", "varrock")], ["GrowFounder"]);
  const clan = Clans.createClan("GrowFounder", "GrowFounder", "varrock", Clans.KIND_SOCIAL);
  befriend("GrowFounder", "GrowPal");
  assert.equal(Life.maybeGrowClan(d, clan, always), true);
  assert.equal(Clans.clanOf("GrowPal")?.id, clan.id);
});

// --- outings -------------------------------------------------------------------------

check("maybeStartOuting creates outing, follows members, nudges leader", () => {
  const founder = rec("OutFounder", "commoner", "varrock", null, ["outgoing"]);
  const m1 = rec("OutM1", "commoner", "varrock");
  const d = fakeDirector([founder, m1], ["OutFounder", "OutM1"]);
  const clan = Clans.createClan("OutFounder", "OutFounder", "varrock", Clans.KIND_SKILL);
  Clans.addMember(clan.id, "OutM1", "OutM1");
  assert.equal(Life.maybeStartOuting(d, clan, always, Date.now()), true);
  assert.ok(clan.activeOuting, "outing active");
  assert.ok(["fishing", "mining"].includes(clan.activeOuting.activity));
  assert.equal(Bonds.getFollow("OutM1")?.reason, "clan_outing");
  assert.ok(navCalls.length > 0, "leader nudged toward destination");
  assert.ok(said.length > 0, "outing announced");
});

check("maintainOuting ends on timeout and clears follows", () => {
  const founder = rec("OutFounder2", "commoner", "varrock", null, ["outgoing"]);
  const m1 = rec("OutM1b", "commoner", "varrock");
  const d = fakeDirector([founder, m1], ["OutFounder2", "OutM1b"]);
  const clan = Clans.createClan("OutFounder2", "OutFounder2", "varrock", Clans.KIND_SOCIAL);
  Clans.addMember(clan.id, "OutM1b", "OutM1b");
  const now = Date.now();
  Life.maybeStartOuting(d, clan, always, now);
  assert.ok(clan.activeOuting);
  Life.maintainOuting(d, clan, always, now + 31 * 60 * 1000);
  assert.equal(clan.activeOuting, null);
  assert.equal(Bonds.getFollow("OutM1b"), null);
});

// --- celebrations ----------------------------------------------------------------------

check("tickCelebrations celebrates a member's real achievement", () => {
  const founder = rec("CelFounder", "commoner", "varrock", null, ["outgoing"]);
  const m1 = rec("CelM1", "commoner", "varrock");
  const d = fakeDirector([founder, m1], ["CelFounder", "CelM1"]);
  const clan = Clans.createClan("CelFounder", "CelFounder", "varrock", Clans.KIND_SOCIAL);
  Clans.addMember(clan.id, "CelM1", "CelM1");
  const t0 = Date.now();
  clan.lastCelebScan = t0 - 1000;
  getJournal().log("CelM1", "achievement", "Reached level 50 fishing.", {
    data: { level: 50, skill: "fishing" },
    at: t0,
  });
  Life.tickCelebrations(d, clan, always, t0 + 5000);
  assert.ok(clan.lastCelebScan >= t0, "scan cursor advanced");
  assert.ok(said.some((s) => /celm1/i.test(s)), "a clanmate congratulated");
  assert.ok(
    (getJournal().recent("CelFounder", 5) ?? []).some((e) => /celebrated/i.test(e.text)),
    "celebration journaled"
  );
});

check("tickCelebrations ignores stale achievements", () => {
  const founder = rec("CelFounder2", "commoner", "varrock", null, ["outgoing"]);
  const d = fakeDirector([founder], ["CelFounder2"]);
  const clan = Clans.createClan("CelFounder2", "CelFounder2", "varrock", Clans.KIND_SOCIAL);
  const t0 = Date.now();
  clan.lastCelebScan = t0;
  getJournal().log("CelFounder2", "achievement", "Reached level 50 fishing.", {
    data: { level: 50, skill: "fishing" },
    at: t0 - 5000,
  });
  Life.tickCelebrations(d, clan, always, t0 + 5000);
  assert.equal(said.length, 0, "no celebration for old news");
});

// --- moots -------------------------------------------------------------------------------

check("achievementScore counts in-window achievements only", () => {
  const now = Date.now();
  getJournal().log("ScoreA", "achievement", "leveled", { data: { level: 10, skill: "x" }, at: now - 1000 });
  getJournal().log("ScoreA", "achievement", "leveled", { data: { level: 11, skill: "x" }, at: now - 8 * 24 * 3600 * 1000 });
  getJournal().log("ScoreA", "social", "chatted", { at: now - 1000 });
  assert.equal(Life.achievementScore(["ScoreA"], now - 7 * 24 * 3600 * 1000), 1);
});

check("tickMoots scores two clans and announces a winner", () => {
  const now = Date.now();
  const mk = (u) => rec(u, "commoner", "varrock", null, u === "MootA1" || u === "MootB1" ? ["outgoing"] : []);
  const d = fakeDirector(["MootA1", "MootA2", "MootB1", "MootB2"].map(mk), ["MootA1", "MootB1"]);
  const ca = Clans.createClan("MootA1", "MootA1", "varrock", Clans.KIND_SKILL);
  Clans.addMember(ca.id, "MootA2", "MootA2");
  const cb = Clans.createClan("MootB1", "MootB1", "varrock", Clans.KIND_SKILL);
  Clans.addMember(cb.id, "MootB2", "MootB2");
  getJournal().log("MootA1", "achievement", "leveled", { data: { level: 40, skill: "fishing" }, at: now - 1000 });
  getJournal().log("MootA2", "achievement", "leveled", { data: { level: 41, skill: "fishing" }, at: now - 2000 });
  getJournal().log("MootB1", "achievement", "leveled", { data: { level: 30, skill: "mining" }, at: now - 3000 });
  Life.tickMoots(d, always, now);
  assert.ok(Clans.lastMootAt("varrock") >= now - 1000, "moot stamped");
  assert.ok(said.some((s) => /moot/i.test(s)), "winner announced");
  // Second tick within the window does nothing.
  said.length = 0;
  Life.tickMoots(d, always, now + 1000);
  assert.equal(said.length, 0, "moot on cooldown");
});

// --- warmth -------------------------------------------------------------------------------

check("tickWarmth greets nearby clanmates", () => {
  const founder = rec("WarmFounder", "commoner", "varrock", null, ["outgoing"]);
  const m1 = rec("WarmM1", "commoner", "varrock");
  const d = fakeDirector([founder, m1], ["WarmFounder", "WarmM1"]);
  // Move the two bots next to each other.
  d._bots.set("warmfounder", fakeBot("WarmFounder", 3000, 3000, 0));
  d._bots.set("warmm1", fakeBot("WarmM1", 3002, 3001, 0));
  const clan = Clans.createClan("WarmFounder", "WarmFounder", "varrock", Clans.KIND_SOCIAL);
  Clans.addMember(clan.id, "WarmM1", "WarmM1");
  Life.tickWarmth(d, clan, seq());
  assert.ok(said.length > 0, "greeting spoken");
});

check("tickClans runs end-to-end without throwing", () => {
  const founder = rec("TickFounder", "commoner", "varrock", "master_trade", ["outgoing"]);
  const f1 = rec("TickF1", "commoner", "varrock", "master_trade", []);
  const f2 = rec("TickF2", "commoner", "varrock", "master_trade", []);
  const f3 = rec("TickF3", "commoner", "varrock", null, []);
  const d = fakeDirector([founder, f1, f2, f3], ["TickFounder", "TickF1"]);
  befriend("TickFounder", "TickF1");
  befriend("TickFounder", "TickF2");
  befriend("TickFounder", "TickF3");
  assert.doesNotThrow(() => Life.tickClans(d, Date.now()));
});

// --- player invites: inviter selection ------------------------------------------------

check("maybeInvitePlayer prefers the founder as inviter", () => {
  const founder = rec("PiFounder", "commoner", "varrock", null, ["taciturn"]);
  const m1 = rec("PiM1", "commoner", "varrock", null, ["chatty"]);
  const d = onlineDirector([founder, m1], ["PiPlayer"]);
  const clan = Clans.createClan("PiFounder", "PiFounder", "varrock", Clans.KIND_SOCIAL);
  Clans.addMember(clan.id, "PiM1", "PiM1");
  befriend("PiFounder", "PiPlayer");
  bondToFriend("PiFounder", "PiPlayer", "Helped me with chore");
  assert.equal(Life.maybeInvitePlayer(d, clan, always, Date.now()), true);
  const inv = Bonds.getInvites("PiPlayer")[0];
  assert.ok(inv, "invite sent");
  assert.equal(inv.from, "pifounder", "the founder extended the invite");
});

check("maybeInvitePlayer prefers social-trait members over a random pick", () => {
  const chatty = rec("PtChatty", "commoner", "varrock", null, ["chatty"]);
  const gruff = rec("PtGruff", "commoner", "varrock", null, ["gruff"]);
  const d = onlineDirector([chatty, gruff], ["PtPlayer"]);
  // Ghost founder: not on the roster, so trait preference decides.
  const clan = Clans.createClan("PtGhost", "PtGhost", "varrock", Clans.KIND_SOCIAL);
  Clans.addMember(clan.id, "PtGruff", "PtGruff");
  Clans.addMember(clan.id, "PtChatty", "PtChatty");
  for (const m of ["PtChatty", "PtGruff"]) {
    befriend(m, "PtPlayer");
    bondToFriend(m, "PtPlayer", `Favor from ${m}`);
  }
  assert.equal(Life.maybeInvitePlayer(d, clan, always, Date.now()), true);
  const inv = Bonds.getInvites("PtPlayer")[0];
  // always-rng would pick PtGruff (first entry); the trait pick is PtChatty.
  assert.equal(inv.from, "ptchatty", "chatty member invited, not the random pick");
});

check("maybeInvitePlayer falls back to a random member when no traits qualify", () => {
  const m1 = rec("PrA", "commoner", "varrock", null, ["taciturn"]);
  const m2 = rec("PrB", "commoner", "varrock", null, ["gruff"]);
  const d = onlineDirector([m1, m2], ["PrPlayer"]);
  const clan = Clans.createClan("PrGhost", "PrGhost", "varrock", Clans.KIND_SOCIAL);
  Clans.addMember(clan.id, "PrA", "PrA");
  Clans.addMember(clan.id, "PrB", "PrB");
  befriend("PrA", "PrPlayer");
  bondToFriend("PrA", "PrPlayer", "Quiet favor");
  assert.equal(Life.maybeInvitePlayer(d, clan, always, Date.now()), true);
  const inv = Bonds.getInvites("PrPlayer")[0];
  assert.equal(inv.from, "pra", "falls back to a member (always-rng picks the first)");
});

// --- player invites: bond threshold gate ----------------------------------------------

check("maybeInvitePlayer requires a sustained bond (score >= FRIEND_AT)", () => {
  const founder = rec("PbFounder", "commoner", "varrock", null, ["outgoing"]);
  const d = onlineDirector([founder], ["PbPlayer"]);
  const clan = Clans.createClan("PbFounder", "PbFounder", "varrock", Clans.KIND_SOCIAL);
  befriend("PbFounder", "PbPlayer"); // friends list only — no bond score yet
  assert.equal(SocialBonds.scoreOf("PbFounder", "PbPlayer"), 0);
  assert.equal(
    Life.maybeInvitePlayer(d, clan, always, Date.now()),
    false,
    "no invite below FRIEND_AT"
  );
  assert.equal(Bonds.getInvites("PbPlayer").length, 0, "nothing sent");
  bondToFriend("PbFounder", "PbPlayer", "Bond favor");
  assert.ok(SocialBonds.scoreOf("PbFounder", "PbPlayer") >= SocialBonds.FRIEND_AT);
  assert.equal(
    Life.maybeInvitePlayer(d, clan, always, Date.now()),
    true,
    "invite at FRIEND_AT"
  );
  const inv = Bonds.getInvites("PbPlayer")[0];
  assert.ok(inv, "invite sent");
  assert.equal(inv.kind, Bonds.INVITE_CLAN, "rides the INVITE_CLAN transport");
  assert.equal(String(inv.data?.clanId), String(clan.id), "carries the clan id");
  // The player nudge keeps the real accept path text.
  assert.ok(
    sentToPlayer.some((e) => e.text.includes('Reply "yes" to accept')),
    "nudge tells the player how to accept"
  );
});

// --- player invites: online-only ------------------------------------------------------

check("maybeInvitePlayer skips offline players", () => {
  const founder = rec("PoFounder", "commoner", "varrock", null, ["outgoing"]);
  const d = onlineDirector([founder], []); // nobody online
  const clan = Clans.createClan("PoFounder", "PoFounder", "varrock", Clans.KIND_SOCIAL);
  befriend("PoFounder", "PoPlayer");
  bondToFriend("PoFounder", "PoPlayer", "Offline favor");
  assert.equal(
    Life.maybeInvitePlayer(d, clan, always, Date.now()),
    false,
    "offline player not invited"
  );
  assert.equal(Bonds.getInvites("PoPlayer").length, 0, "no invite sent");
  assert.equal(Clans.inviteCooldownOf("PoPlayer").lastInviteAt, 0, "no cooldown stamped");
});

// --- player invites: cooldown / decline / ignore --------------------------------------

check("maybeInvitePlayer throttles re-invites and honors declines", () => {
  const founder = rec("PcFounder", "commoner", "varrock", null, ["outgoing"]);
  const d = onlineDirector([founder], ["PcPlayer"]);
  const clan = Clans.createClan("PcFounder", "PcFounder", "varrock", Clans.KIND_SOCIAL);
  befriend("PcFounder", "PcPlayer");
  bondToFriend("PcFounder", "PcPlayer", "Cooldown favor");
  const t0 = Date.now();
  assert.equal(Life.maybeInvitePlayer(d, clan, always, t0), true, "first invite goes out");
  // Still pending: no nag, and pending is not misread as declined.
  assert.equal(
    Life.maybeInvitePlayer(d, clan, always, t0 + 60 * 1000),
    false,
    "no nag while pending"
  );
  assert.equal(
    Clans.inviteCooldownOf("PcPlayer").noAskUntil,
    0,
    "pending invite does not start a no-ask window"
  );
  // Decline it.
  const inv = Bonds.getInvites("PcPlayer")[0];
  Bonds.resolveInvite("PcPlayer", inv.id, false);
  assert.equal(
    Life.maybeInvitePlayer(d, clan, always, t0 + 2 * 3600 * 1000),
    false,
    "no re-ask right after a decline"
  );
  const cd = Clans.inviteCooldownOf("PcPlayer");
  assert.ok(cd.noAskUntil > t0 + 2 * 3600 * 1000, "7-day no-re-ask registered");
  // Once the window passes, the player is eligible again.
  assert.equal(
    Life.maybeInvitePlayer(d, clan, always, cd.noAskUntil + 1000),
    true,
    "eligible once the no-ask window expires"
  );
});

check("maybeInvitePlayer treats an expired invite as ignored", () => {
  const founder = rec("PgFounder", "commoner", "varrock", null, ["outgoing"]);
  const d = onlineDirector([founder], ["PgPlayer"]);
  const clan = Clans.createClan("PgFounder", "PgFounder", "varrock", Clans.KIND_SOCIAL);
  befriend("PgFounder", "PgPlayer");
  bondToFriend("PgFounder", "PgPlayer", "Ignore favor");
  const t0 = Date.now();
  assert.equal(Life.maybeInvitePlayer(d, clan, always, t0), true);
  // Simulate the 10-minute TTL expiring with no answer.
  Bonds.bonds("PgPlayer").pendingInvites.length = 0;
  assert.equal(
    Life.maybeInvitePlayer(d, clan, always, t0 + 3600 * 1000),
    false,
    "ignored invite -> no re-ask"
  );
  assert.ok(
    Clans.inviteCooldownOf("PgPlayer").noAskUntil > t0,
    "no-ask window registered for the ignored invite"
  );
});

// --- player invites: history-flavored lines -------------------------------------------

check("maybeInvitePlayer quotes real favor history in the invite line", () => {
  const founder = rec("PfFounder", "commoner", "varrock", null, ["outgoing"]);
  const d = onlineDirector([founder], ["PfPlayer"], ["PfFounder"]);
  const clan = Clans.createClan("PfFounder", "PfFounder", "varrock", Clans.KIND_SOCIAL);
  befriend("PfFounder", "PfPlayer");
  for (let i = 0; i < 4; i++) SocialBonds.recordFavor("PfFounder", "PfPlayer", "Gave me a bronze dagger.");
  SocialBonds.recordFavor("PfFounder", "PfPlayer", "Gave me an iron sword.");
  // Unit level: the flavor builder quotes the freshest REAL story.
  const flavor = Life.playerInviteFlavor("PfFounder", "PfPlayer", "Varrock Fellows");
  assert.ok(flavor, "flavor built from history");
  assert.ok(
    flavor.plain[0].includes("gave me an iron sword"),
    "freshest favor story quoted, got: " + flavor.plain[0]
  );
  assert.ok(
    [...flavor.plain, ...flavor.terse].every((l) => l.length <= 80),
    "flavor lines fit the 80-char chat truncation"
  );
  assert.equal(
    Life.playerInviteFlavor("PfFounder", "NobodyAtAll", "Varrock Fellows"),
    null,
    "no history -> null (caller uses the generic pool)"
  );
  // Integration level: the spoken line carries the real history.
  assert.equal(Life.maybeInvitePlayer(d, clan, always, Date.now()), true);
  assert.ok(said.length > 0, "inviter spoke");
  assert.ok(
    said.some((s) => s.includes("gave me an iron sword")),
    "spoken line quotes the real favor, got: " + JSON.stringify(said)
  );
  assert.ok(said.every((s) => s.length <= 80), "spoken lines fit chat truncation");
});

check("maybeInvitePlayer falls back to generic lines with no shared history", () => {
  const founder = rec("PzFounder", "commoner", "varrock", null, ["outgoing"]);
  const d = onlineDirector([founder], ["PzPlayer"], ["PzFounder"]);
  const clan = Clans.createClan("PzFounder", "PzFounder", "varrock", Clans.KIND_SOCIAL);
  befriend("PzFounder", "PzPlayer");
  // Bond via interactions only — no favor stories on record.
  for (let i = 0; i < 4; i++) SocialBonds.recordInteraction("PzFounder", "PzPlayer", "befriended");
  assert.ok(SocialBonds.scoreOf("PzFounder", "PzPlayer") >= SocialBonds.FRIEND_AT);
  assert.equal(SocialBonds.favors("PzFounder", "PzPlayer").length, 0, "no favor history");
  assert.equal(Life.maybeInvitePlayer(d, clan, always, Date.now()), true);
  assert.ok(said.length > 0, "inviter spoke");
  assert.ok(said.every((s) => s.length <= 80), "lines fit chat truncation");
  assert.ok(!said.some((s) => /remember/i.test(s)), "no history quoted");
  assert.ok(said.some((s) => s.includes(clan.name)), "clan named in the generic line");
});

// --- accept path unchanged ------------------------------------------------------------

check("clan invite accept path still joins the player", () => {
  const clan = Clans.createClan("PaFounder", "PaFounder", "varrock", Clans.KIND_SOCIAL);
  const id = Clans.invitePlayer("PaFounder", "PaPlayer", clan.id);
  assert.ok(id, "invite created");
  const inv = Bonds.getInvites("PaPlayer")[0];
  assert.equal(inv.kind, Bonds.INVITE_CLAN, "still rides INVITE_CLAN");
  assert.equal(String(inv.data?.clanId), String(clan.id), "still carries the clan id");
  // Tail of the real path: player says "yes" -> CitizenChat acceptInvite ->
  // SocialMechanics.acceptInvite -> CitizenClans.playerAcceptsClan.
  assert.equal(Clans.playerAcceptsClan("PaPlayer", clan.id, "PaPlayer"), true);
  assert.ok(Clans.clanOfPlayer("PaPlayer"), "player joined the clan");
});

console.log(`\n${passed} checks passed`);
