// CitizenClans unit checks — pure data logic, no running server.
const assert = require("node:assert/strict");
const path = require("node:path");
const Clans = require("./CitizenClans");
const Bonds = require("./CitizenBonds");

let passed = 0;
function check(name, fn) {
  Clans.resetForTests();
  fn();
  passed++;
  console.log("ok - " + name);
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

// --- kind derivation ----------------------------------------------------------

check("kindForRecord derives kind from role and goal", () => {
  assert.equal(Clans.kindForRecord(rec("a", "guard")), Clans.KIND_GUARD);
  assert.equal(Clans.kindForRecord(rec("a", "merchant")), Clans.KIND_TRADE);
  assert.equal(Clans.kindForRecord(rec("a", "commoner", "varrock", "master_trade")), Clans.KIND_CRAFT);
  assert.equal(Clans.kindForRecord(rec("a", "commoner", "varrock", "save_gold")), Clans.KIND_TRADE);
  assert.equal(Clans.kindForRecord(rec("a", "commoner", "varrock", "boss_slayer")), Clans.KIND_GUARD);
  assert.equal(Clans.kindForRecord(rec("a", "commoner", "varrock", "rank_up")), Clans.KIND_GUARD);
  assert.equal(Clans.kindForRecord(rec("a", "commoner", "varrock", "make_friends")), Clans.KIND_SOCIAL);
  assert.equal(Clans.kindForRecord(rec("a")), Clans.KIND_SOCIAL);
  assert.equal(Clans.kindForRecord(null), Clans.KIND_SOCIAL);
});

// --- creation -------------------------------------------------------------------

check("createClan founds with derived name and founder as leader", () => {
  const clan = Clans.createClan("Founder One", "Founder One", "varrock", Clans.KIND_CRAFT);
  assert.ok(clan);
  assert.equal(clan.leader, "founder one");
  assert.deepEqual(clan.members, ["founder one"]);
  assert.ok(clan.name.includes("Crafters"));
  assert.equal(Clans.clanOf("Founder One")?.id, clan.id);
  assert.equal(Clans.clanOf("founder one")?.id, clan.id); // normalized
});

check("createClan caps clans per kind per kingdom", () => {
  for (let i = 0; i < Clans.MAX_CLANS_PER_KINGDOM; i++) {
    const c = Clans.createClan(`Founder${i}`, `Founder${i}`, "varrock", Clans.KIND_SOCIAL);
    assert.ok(c, `clan ${i} created`);
  }
  const extra = Clans.createClan("FounderX", "FounderX", "varrock", Clans.KIND_SOCIAL);
  assert.equal(extra, null);
  // A different kind still works.
  const other = Clans.createClan("FounderY", "FounderY", "varrock", Clans.KIND_GUARD);
  assert.ok(other);
});

check("createClan disambiguates same-kind names", () => {
  const a = Clans.createClan("FA", "FA", "varrock", Clans.KIND_TRADE);
  const b = Clans.createClan("FB", "FB", "varrock", Clans.KIND_TRADE);
  assert.notEqual(a.name, b.name);
});

// --- membership ------------------------------------------------------------------

check("addMember enforces one clan per citizen and the member cap", () => {
  const clan = Clans.createClan("G1", "G1", "varrock", Clans.KIND_SOCIAL);
  assert.equal(Clans.addMember(clan.id, "MemberA", "MemberA"), true);
  assert.equal(Clans.addMember(clan.id, "membera", "MemberA"), false); // dup (normalized)
  const other = Clans.createClan("G2", "G2", "varrock", Clans.KIND_SOCIAL);
  assert.equal(Clans.addMember(other.id, "MemberA", "MemberA"), false); // already in a clan
  // Fill to cap.
  for (let i = 0; i < Clans.MAX_MEMBERS; i++) {
    Clans.addMember(clan.id, `Cap${i}`, `Cap${i}`);
  }
  assert.equal(Clans.addMember(clan.id, "Overflow", "Overflow"), false);
});

check("removeMember promotes the longest-standing member and disbands when empty", () => {
  const clan = Clans.createClan("Boss", "Boss", "varrock", Clans.KIND_SOCIAL);
  Clans.addMember(clan.id, "Second", "Second");
  Clans.addMember(clan.id, "Third", "Third");
  Clans.removeMember(clan.id, "Boss");
  assert.equal(Clans.getClan(clan.id).leader, "second");
  assert.equal(Clans.clanOf("Boss"), null);
  Clans.removeMember(clan.id, "Second");
  Clans.removeMember(clan.id, "Third");
  assert.equal(Clans.getClan(clan.id), null); // disbanded
  assert.equal(Clans.clanCount(), 0);
});

// --- founder eligibility ----------------------------------------------------------

check("founderEligible needs leadership traits, 3 citizen friends, clanless", () => {
  const isCitizen = (n) => String(n).startsWith("citz");
  const r = rec("LeadA", "commoner", "varrock", null, ["outgoing"]);
  assert.equal(Clans.founderEligible(r, isCitizen), false); // no friends yet
  Bonds.addFriend("LeadA", "citz1"); Bonds.addFriend("citz1", "LeadA");
  Bonds.addFriend("LeadA", "citz2"); Bonds.addFriend("citz2", "LeadA");
  Bonds.addFriend("LeadA", "citz3"); Bonds.addFriend("citz3", "LeadA");
  assert.equal(Clans.founderEligible(r, isCitizen), true);
  const shy = rec("ShyB", "commoner", "varrock", null, ["taciturn"]);
  Bonds.addFriend("ShyB", "citz1"); Bonds.addFriend("citz1", "ShyB");
  Bonds.addFriend("ShyB", "citz2"); Bonds.addFriend("citz2", "ShyB");
  Bonds.addFriend("ShyB", "citz3"); Bonds.addFriend("citz3", "ShyB");
  assert.equal(Clans.founderEligible(shy, isCitizen), false); // no leader traits
  // In a clan already -> not eligible.
  const clan = Clans.createClan("LeadA", "LeadA", "varrock", Clans.KIND_SOCIAL);
  assert.ok(clan);
  assert.equal(Clans.founderEligible(r, isCitizen), false);
});

// --- invites ------------------------------------------------------------------------

check("citizen invite flow: inviteCitizen then acceptClanInvite joins", () => {
  const clan = Clans.createClan("InvFounder", "InvFounder", "varrock", Clans.KIND_SOCIAL);
  const id = Clans.inviteCitizen("InvFounder", "InviteeZed", clan.id);
  assert.ok(id);
  const pending = Bonds.getInvites("InviteeZed");
  assert.ok(pending.some((i) => i.kind === Bonds.INVITE_CLAN && i.data.clanId === clan.id));
  assert.equal(Clans.acceptClanInvite("InviteeZed", clan.id, true), true);
  assert.equal(Clans.clanOf("InviteeZed")?.id, clan.id);
  // Declining does not join.
  const id2 = Clans.inviteCitizen("InvFounder", "DeclinerZed", clan.id);
  assert.ok(id2);
  assert.equal(Clans.acceptClanInvite("DeclinerZed", clan.id, false), true);
  assert.equal(Clans.clanOf("DeclinerZed"), null);
});

check("inviteCitizen refuses citizens already in a clan", () => {
  const a = Clans.createClan("IA", "IA", "varrock", Clans.KIND_SOCIAL);
  const b = Clans.createClan("IB", "IB", "varrock", Clans.KIND_SOCIAL);
  Clans.addMember(a.id, "BusyZed", "BusyZed");
  assert.equal(Clans.inviteCitizen("IB", "BusyZed", b.id), null);
});

// --- players --------------------------------------------------------------------------

check("player invite flow: invitePlayer then playerAcceptsClan", () => {
  const clan = Clans.createClan("PFounder", "PFounder", "varrock", Clans.KIND_SOCIAL);
  const id = Clans.invitePlayer("PFounder", "RealPlayerOne", clan.id);
  assert.ok(id);
  assert.equal(Clans.clanOfPlayer("RealPlayerOne"), null); // not yet
  assert.equal(Clans.playerAcceptsClan("RealPlayerOne", clan.id, "RealPlayerOne"), true);
  assert.equal(Clans.clanOfPlayer("RealPlayerOne")?.id, clan.id);
  assert.equal(Clans.playerAcceptsClan("RealPlayerOne", clan.id), false); // dup
});

check("requestJoinClan: founder accepts player friends, strangers wait", () => {
  const clan = Clans.createClan("JFounder", "JFounder", "varrock", Clans.KIND_SOCIAL);
  Bonds.addFriend("JFounder", "PlayerFriend"); Bonds.addFriend("PlayerFriend", "JFounder");
  const id1 = Clans.requestJoinClan("PlayerFriend", clan.id);
  const id2 = Clans.requestJoinClan("PlayerStranger", clan.id);
  assert.ok(id1 && id2);
  const { accepted } = Clans.processJoinRequests();
  assert.equal(accepted, 1);
  assert.equal(Clans.clanOfPlayer("PlayerFriend")?.id, clan.id);
  assert.equal(Clans.clanOfPlayer("PlayerStranger"), null); // still pending
});

check("removeMember handles players and clanOf lookups", () => {
  const clan = Clans.createClan("RF", "RF", "varrock", Clans.KIND_SOCIAL);
  Clans.addPlayerMember(clan.id, "SomePlayer", "SomePlayer");
  assert.equal(Clans.clanOfPlayer("SomePlayer")?.id, clan.id);
  Clans.removeMember(clan.id, "SomePlayer");
  assert.equal(Clans.clanOfPlayer("SomePlayer"), null);
  assert.ok(Clans.getClan(clan.id)); // citizen founder remains
});

// --- persistence shape -------------------------------------------------------------------

check("save writes clans and moot meta without throwing", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clans-")), "citizen-clans.json");
  Clans._setSavePathForTests(tmp);
  try {
    const clan = Clans.createClan("SF", "SF", "varrock", Clans.KIND_GUARD);
    Clans.stampMoot("varrock", 12345);
    assert.equal(Clans.lastMootAt("varrock"), 12345);
    assert.equal(Clans.lastMootAt("falador"), 0);
    assert.doesNotThrow(() => Clans.save());
    const raw = JSON.parse(fs.readFileSync(tmp, "utf8"));
    assert.ok(raw.clans[clan.id]);
    assert.equal(raw.meta.moots.varrock, 12345);
    assert.ok(clan.activityLog.length > 0);
  } finally {
    Clans._setSavePathForTests(
      require("node:path").join(process.cwd(), "data", "saves", "citizen-clans.json")
    );
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
});

console.log(`\n${passed} checks passed`);
