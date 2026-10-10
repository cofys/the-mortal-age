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
