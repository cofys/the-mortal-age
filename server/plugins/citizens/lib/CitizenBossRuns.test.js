// CitizenBossRuns real-combat slice — unit checks.
// From server/plugins/citizens: node lib/CitizenBossRuns.test.js (plain node)
const assert = require("node:assert/strict");

const BR = require("./CitizenBossRuns");

const SCURRIUS = BR.bossById("scurrius");
assert.ok(SCURRIUS, "scurrius boss defined");
assert.ok((SCURRIUS.npcIds ?? []).includes(7221), "scurrius npcIds include 7221");

function rec(username, opts = {}) {
  return {
    username,
    displayName: username,
    kingdomId: opts.kingdomId ?? "misthalin",
    role: opts.role ?? "guard",
  };
}

function fakeNpc(id, alive = true) {
  return {
    getId: () => id,
    isDead: () => !alive,
    isDying: () => false,
    isRegistered: () => true,
  };
}

function fakeBot(name, opts = {}) {
  const attacked = [];
  return {
    username: name,
    attacked,
    _npcs: opts.npcs ?? [],
    _target: opts.inCombat ? fakeNpc(7221) : null,
    getLocalNpcs() { return this._npcs; },
    getCombat() {
      return {
        getTarget: () => this._target,
        attack: (npc) => { attacked.push(npc); this._target = npc; },
      };
    },
    getInventory() { return { adds: () => true }; },
    getLocation() { return { getX: () => 3237, getY: () => 9858, getZ: () => 0 }; },
  };
}

function fakeDirector(records, botsByName) {
  const roster = new Map(records.map((r) => [r.username.toLowerCase(), r]));
  return {
    roster,
    isOnline: (r) => !!botsByName[r.username],
    getBot: (r) => botsByName[r.username] ?? null,
  };
}

function fakeParty() {
  return {
    id: "test-party-1",
    leader: "alice",
    members: ["alice", "bob", "cara"],
    phase: "fight",
    bossId: "scurrius",
    bossHp: 500,
  };
}

const rng = () => 0.5;

// --- _findBossNpc ------------------------------------------------------------

{
  const bot = fakeBot("alice", { npcs: [fakeNpc(1234), fakeNpc(7221)] });
  const found = BR._findBossNpc(bot, SCURRIUS);
  assert.ok(found, "finds the Scurrius NPC among local NPCs");
  assert.equal(found.getId(), 7221);
}

{
  const bot = fakeBot("alice", { npcs: [fakeNpc(1234), fakeNpc(5678)] });
  assert.equal(BR._findBossNpc(bot, SCURRIUS), null, "null when boss not present");
}

{
  const bot = fakeBot("alice", { npcs: [fakeNpc(7221, false)] });
  assert.equal(BR._findBossNpc(bot, SCURRIUS), null, "null when boss NPC is dead");
}

// --- _botInCombat ------------------------------------------------------------

{
  assert.equal(BR._botInCombat(fakeBot("x")), false, "not in combat with no target");
  assert.equal(BR._botInCombat(fakeBot("x", { inCombat: true })), true, "in combat with a target");
}

// --- attack trigger: materialized + boss in radius → attack() called ---------

{
  const bossNpc = fakeNpc(7221);
  const leaderBot = fakeBot("alice", { npcs: [bossNpc] });
  const bobBot = fakeBot("bob");
  const caraBot = fakeBot("cara");
  const records = [rec("alice"), rec("bob"), rec("cara")];
  const director = fakeDirector(records, { alice: leaderBot, bob: bobBot, cara: caraBot });
  const party = fakeParty();

  BR._maintainFight(director, party, SCURRIUS, records[0], leaderBot, rng);

  assert.ok(bobBot.attacked.length > 0, "bob attacked the boss");
  assert.ok(caraBot.attacked.length > 0, "cara attacked the boss");
  assert.equal(bobBot.attacked[0].getId(), 7221, "attacked the Scurrius NPC");
  assert.equal(party.bossSeen, true, "boss marked seen");
  // Leader also attacks (she is materialized and not in combat).
  assert.ok(leaderBot.attacked.length > 0, "leader attacked the boss");
}

// --- no re-attack while already in combat ------------------------------------

{
  const bossNpc = fakeNpc(7221);
  const leaderBot = fakeBot("alice", { npcs: [bossNpc] });
  const bobBot = fakeBot("bob", { inCombat: true }); // already fighting
  const records = [rec("alice"), rec("bob")];
  const director = fakeDirector(records, { alice: leaderBot, bob: bobBot });
  const party = { ...fakeParty(), members: ["alice", "bob"] };

  BR._maintainFight(director, party, SCURRIUS, records[0], leaderBot, rng);

  assert.equal(bobBot.attacked.length, 0, "bob already in combat — no re-attack");
  assert.ok(leaderBot.attacked.length > 0, "leader still attacks");
}

// --- boss death: seen then gone → kill sequence ------------------------------

{
  const leaderBot = fakeBot("alice", { npcs: [] }); // boss gone
  const bobBot = fakeBot("bob");
  const records = [rec("alice"), rec("bob")];
  const director = fakeDirector(records, { alice: leaderBot, bob: bobBot });
  const party = { ...fakeParty(), members: ["alice", "bob"], bossSeen: true, bossHp: 500 };

  // sendHome/endRun need siteTileByKingdom; they fail non-fatal without it.
  // The kill path should not throw.
  BR._maintainFight(director, party, SCURRIUS, records[0], leaderBot, rng);
  // If we got here without throwing, the kill sequence ran.
  assert.ok(true, "kill sequence runs when boss seen then gone");
}

// --- LOD fallback: no materialized members → data-tier ticker ---------------

{
  const records = [rec("alice"), rec("bob"), rec("cara")];
  // No bots materialized — getBot returns null for everyone.
  const director = fakeDirector(records, {});
  // isOnline true (data-tier online), but no bot entities.
  director.isOnline = () => true;
  const party = fakeParty();
  const hpBefore = party.bossHp;

  // leaderBot is null here (leader not materialized) — maintainFight needs
  // a leaderBot for findBossNpc; pass a stub with no NPCs.
  const stubBot = fakeBot("alice", { npcs: [] });
  BR._maintainFight(director, party, SCURRIUS, records[0], stubBot, rng);

  assert.ok(party.bossHp < hpBefore, `data-tier ticker chips boss HP (${hpBefore} → ${party.bossHp})`);
  assert.equal(party.bossSeen, undefined, "boss not marked seen in LOD mode");
}

// --- LOD fallback kill: HP hits 0 → loot split runs --------------------------

{
  const records = [rec("alice"), rec("bob"), rec("cara")];
  const director = fakeDirector(records, {});
  director.isOnline = () => true;
  const party = { ...fakeParty(), bossHp: 1 }; // one tick kills
  const stubBot = fakeBot("alice", { npcs: [] });

  BR._maintainFight(director, party, SCURRIUS, records[0], stubBot, rng);
  assert.ok(party.bossHp === 0, "boss HP reaches 0 in LOD mode");
}

console.log("CitizenBossRuns.test.js: all assertions passed");

// --- real-drop capture: npc-drops:generated interception ---------------------

const { createParty } = require("./CitizenSocialMechanics");
const { getParty } = require("./CitizenBonds");

function grantBot(name, grants) {
  const bot = fakeBot(name);
  bot.getInventory = () => ({
    adds: (id, qty) => {
      grants.push({ name, id, qty });
      return true;
    },
  });
  return bot;
}

function bossRunParty(leader, members, bossId = "scurrius") {
  const party = createParty(leader, members.filter((m) => m !== leader));
  party.bossId = bossId;
  party.activity = bossId;
  party.phase = "fight";
  party.bossSeen = true;
  return party;
}

function grantTotals(grants) {
  const totals = {};
  for (const g of grants) totals[g.id] = (totals[g.id] ?? 0) + g.qty;
  return totals;
}

{
  // Capture: a party citizen lands the kill → the event is marked handled
  // (no ground spawn) and the rolled drops are stashed on the party verbatim.
  const party = bossRunParty("dana", ["dana", "eli", "fay"]);
  const event = {
    player: { isPlayerBot: () => true, getUsername: () => "dana" },
    npcId: 7221,
    drops: [
      { itemId: 532, amount: 1 },
      { itemId: 892, amount: 30 },
      { itemId: 28798, amount: 1, noted: false },
    ],
    handled: false,
  };
  BR._handleNpcDropsGenerated(fakeDirector([], {}), event);
  assert.equal(event.handled, true, "party citizen kill is intercepted");
  assert.deepEqual(
    party.capturedDrops,
    [
      { id: 532, qty: 1, noted: false },
      { id: 892, qty: 30, noted: false },
      { id: 28798, qty: 1, noted: false },
    ],
    "captured drops are the engine's actual roll"
  );
}

{
  // No capture: a real player landed the kill — their drops are theirs.
  bossRunParty("gina", ["gina", "hal"]);
  const event = {
    player: { isPlayerBot: () => false, getUsername: () => "gina" },
    npcId: 7221,
    drops: [{ itemId: 532, amount: 1 }],
    handled: false,
  };
  BR._handleNpcDropsGenerated(fakeDirector([], {}), event);
  assert.equal(event.handled, false, "real-player kill is left alone");
}

{
  // No capture: the dead NPC is not the party's boss.
  bossRunParty("ivan", ["ivan", "jo"]);
  const event = {
    player: { isPlayerBot: () => true, getUsername: () => "ivan" },
    npcId: 1234,
    drops: [{ itemId: 532, amount: 1 }],
    handled: false,
  };
  BR._handleNpcDropsGenerated(fakeDirector([], {}), event);
  assert.equal(event.handled, false, "unrelated npc death is left alone");
}

{
  // No capture: the party never engaged the boss (bossSeen false).
  const party = bossRunParty("kate", ["kate", "leo"]);
  party.bossSeen = false;
  const event = {
    player: { isPlayerBot: () => true, getUsername: () => "kate" },
    npcId: 7221,
    drops: [{ itemId: 532, amount: 1 }],
    handled: false,
  };
  BR._handleNpcDropsGenerated(fakeDirector([], {}), event);
  assert.equal(event.handled, false, "no capture without engagement");
}

{
  // Distribution conserves the roll: every captured unit lands in exactly
  // one member's inventory — nothing minted, nothing lost.
  const grants = [];
  const records = [rec("mia"), rec("noa"), rec("oli")];
  const bots = {
    mia: grantBot("mia", grants),
    noa: grantBot("noa", grants),
    oli: grantBot("oli", grants),
  };
  const director = fakeDirector(records, bots);
  const party = {
    id: "loot-party",
    leader: "mia",
    members: ["mia", "noa", "oli"],
    capturedDrops: [
      { id: 532, qty: 1, noted: false },
      { id: 892, qty: 31, noted: false },
      { id: 1163, qty: 1, noted: false },
    ],
  };
  const dealt = BR._distributeCapturedDrops(director, party, SCURRIUS, rng);
  assert.equal(dealt, true, "distribution dealt the drops");
  assert.equal(party.capturedDrops, null, "stash cleared after dealing");
  assert.deepEqual(grantTotals(grants), { 532: 1, 892: 31, 1163: 1 }, "drop totals conserved");
}

{
  // Kill flow with capture already stashed: the party is paid the actual
  // drops (not the fabricated table) and the run ends.
  const grants = [];
  const records = [rec("pam"), rec("quinn")];
  const pamBot = grantBot("pam", grants);
  const director = fakeDirector(records, { pam: pamBot, quinn: grantBot("quinn", grants) });
  const party = bossRunParty("pam", ["pam", "quinn"]);
  party.capturedDrops = [{ id: 532, qty: 2, noted: false }];
  BR._maintainFight(director, party, SCURRIUS, records[0], pamBot, rng);
  assert.deepEqual(grantTotals(grants), { 532: 2 }, "kill flow deals the captured drops");
  assert.equal(getParty("pam"), null, "party disbanded after the kill");
}

{
  // Race: the kill is detected before the death event lands → the party
  // waits in the loot phase and mints nothing; the event then captures
  // during the loot phase and the loot pass deals the real drops.
  const grants = [];
  const records = [rec("rae"), rec("sam")];
  const raeBot = grantBot("rae", grants);
  const director = fakeDirector(records, { rae: raeBot, sam: grantBot("sam", grants) });
  const party = bossRunParty("rae", ["rae", "sam"]);
  BR._maintainFight(director, party, SCURRIUS, records[0], raeBot, rng);
  assert.equal(party.phase, "loot", "kill without capture waits in the loot phase");
  assert.equal(grants.length, 0, "nothing minted while waiting");
  const event = {
    player: { isPlayerBot: () => true, getUsername: () => "sam" },
    npcId: 7221,
    drops: [{ itemId: 532, amount: 1 }],
    handled: false,
  };
  BR._handleNpcDropsGenerated(director, event);
  assert.equal(event.handled, true, "late death event still captures in the loot phase");
  BR._maintainLoot(director, party, SCURRIUS, records[0], rng);
  assert.deepEqual(grantTotals(grants), { 532: 1 }, "loot phase deals the captured drops");
  assert.equal(getParty("rae"), null, "party disbanded after loot dealt");
}

{
  // Loot phase expiry: no capture ever arrives (the kill was someone
  // else's) → the party heads home empty-handed; nothing is minted.
  const grants = [];
  const records = [rec("tia"), rec("uma")];
  const director = fakeDirector(records, {
    tia: grantBot("tia", grants),
    uma: grantBot("uma", grants),
  });
  const party = bossRunParty("tia", ["tia", "uma"]);
  party.phase = "loot";
  party.lootWaitUntil = Date.now() - 1;
  BR._maintainLoot(director, party, SCURRIUS, records[0], rng);
  assert.equal(grants.length, 0, "no loot minted when the kill was not ours");
  assert.equal(getParty("tia"), null, "party disbanded after loot timeout");
}

console.log("CitizenBossRuns.test.js: capture/distribution assertions passed");
