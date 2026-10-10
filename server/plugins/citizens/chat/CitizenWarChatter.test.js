"use strict";

// CitizenWarChatter unit checks — pure logic, no running server.
//
// Verified real data shapes these tests are built on (from
// server/plugins/kingdoms/Wars.Kingdoms.js and KingdomStore.js):
//
//   Wars.getWars(kingdomId, store) returns an ARRAY of records shaped EXACTLY:
//     { attackerId, defenderId, goal, goalLabel, declaredAt, declaredBy }
//   where goal is one of "loot" | "territory" | "vassalize" and goalLabel is
//   WAR_GOAL_LABELS[goal] ("Plunder" | "Territory" | "Vassalize").
//   NOTE: getWars does NOT return `reason` — only the mapped fields above.
//   The module must never speak of a war that isn't in that array.
//
//   KingdomStore.getTensionMap() returns { "a:b": score } with canonical
//   "a:b" keys (a < b), score 0-100.
//
//   KingdomStore.getKingdom(id) returns the kingdom object (has .name) or
//   null. A null record means "not a real kingdom" — the module stays silent.
//
// Tests inject fake stores/readers through tickWarChatter's `overrides`, so
// no test depends on the live store or on files being written.

const assert = require("node:assert/strict");
const Chatter = require("./CitizenWarChatter");
const { resetForTests: resetSayPublic } = require("./CitizenSayPublic");
const { BAND_NEAR, BAND_FAR } = require("../lib/CitizenTickLod");

const {
  tickWarChatter,
  _resetForTests,
  _pickWarLine,
  _pickTensionLine,
  _highTensionNeighbor,
  _chatterChance,
  _nextChatterAt,
  WAR_CHATTER_MIN_MS,
  TENSION_RUMOR_THRESHOLD,
} = Chatter;

// --- real-world fixtures ------------------------------------------------------

// Real getWars record shape: { attackerId, defenderId, goal, goalLabel,
// declaredAt, declaredBy }. Territory war, "varrock" attacking "falador".
const REAL_WAR_TERRITORY = {
  attackerId: "varrock",
  defenderId: "falador",
  goal: "territory",
  goalLabel: "Territory",
  declaredAt: 1000,
  declaredBy: "player-one",
};

const REAL_WAR_PLUNDER = {
  attackerId: "lumbridge",
  defenderId: "varrock",
  goal: "loot",
  goalLabel: "Plunder",
  declaredAt: 2000,
  declaredBy: null,
};

// Fake kingdom store: real records only, shaped like the real store.
function makeGetKingdom(names = { varrock: "Varrock", falador: "Falador", lumbridge: "Lumbridge" }) {
  return (id) => (names[id] ? { id, name: names[id] } : null);
}

// --- mocks (same shape as CitizenActivityChatter.test.js) ---------------------

function makeRealPlayer(username = "Cofy") {
  const sent = [];
  return {
    player: {
      getUsername: () => username,
      getIndex: () => 7,
      getHostAddress: () => "127.0.0.1",
      isPlayerBot: () => false,
      getRelations: () => ({ canReceivePublicChatFrom: () => true }),
      getPacketSender: () => ({
        sendPublicChat: (message, from, playerId) => sent.push({ message, from, playerId }),
      }),
    },
    sent,
  };
}

function makeBot({
  username = "Mira",
  personality = { traits: ["chatty"] },
  kingdomId = "varrock",
  locals = [],
} = {}) {
  const forced = [];
  const attrs = { "kingdom:id": kingdomId, "citizens:personality": personality };
  return {
    bot: {
      getUsername: () => username,
      getAttribute: (k) => attrs[k] ?? null,
      getLocalPlayers: () => locals.map((l) => l.player),
      forceChat: (text) => forced.push(text),
    },
    forced,
  };
}

function makeDirector(bot, recordUsername = "Mira") {
  return {
    roster: new Map([[recordUsername.toLowerCase(), { username: recordUsername }]]),
    isOnline: () => true,
    getBot: () => bot,
  };
}

function makeOverrides(extra = {}) {
  const logged = [];
  return {
    journal: { log: (name, kind, text) => logged.push({ name, kind, text }) },
    logged,
    bandFor: () => BAND_NEAR,
    getKingdom: makeGetKingdom(),
    ...extra,
  };
}

let origRandom = null;
function fixRandom(value = 0) {
  origRandom = Math.random;
  Math.random = () => value;
}
function unfixRandom() {
  if (origRandom) Math.random = origRandom;
  origRandom = null;
}

function run(name, fn) {
  _resetForTests();
  resetSayPublic();
  fixRandom(0);
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}: ${e.message}`);
    process.exitCode = 1;
  } finally {
    unfixRandom();
  }
}

// --- line picking -------------------------------------------------------------

run("pickWarLine: names the real enemy kingdom and real goal label", () => {
  // Mira's kingdom is varrock (the attacker). Enemy = Falador. Goal = Territory.
  const line = _pickWarLine(REAL_WAR_TERRITORY, "varrock", "Falador", { traits: ["chatty"] }, () => 0);
  assert.ok(line.includes("Falador"), `expected real enemy name in "${line}"`);
  assert.ok(line.includes("Territory"), `expected real goal label in "${line}"`);
  assert.ok(!/varrock/i.test(line), `citizen doesn't name themselves: "${line}"`);
});

run("pickWarLine: defender-side lines differ from attacker-side", () => {
  const defender = _pickWarLine(REAL_WAR_TERRITORY, "falador", "Varrock", { traits: ["chatty"] }, () => 0);
  const attacker = _pickWarLine(REAL_WAR_TERRITORY, "varrock", "Falador", { traits: ["chatty"] }, () => 0);
  assert.notEqual(defender, attacker, "attacker and defender should talk differently");
  assert.ok(defender.includes("Varrock"), `defender names the attacker: "${defender}"`);
});

run("pickWarLine: terse voice for gruff citizen", () => {
  const line = _pickWarLine(REAL_WAR_TERRITORY, "varrock", "Falador", { traits: ["gruff"] }, () => 0);
  assert.equal(line, "war with Falador.");
});

run("pickWarLine: null when war or enemy name missing (never invent)", () => {
  assert.equal(_pickWarLine(null, "varrock", "Falador", {}, () => 0), null);
  assert.equal(_pickWarLine(REAL_WAR_TERRITORY, "varrock", null, {}, () => 0), null);
});

run("pickWarLine: plunder goal uses the real Plunder label", () => {
  const line = _pickWarLine(REAL_WAR_PLUNDER, "lumbridge", "Varrock", { traits: ["chatty"] }, () => 0);
  assert.ok(line.includes("Varrock") && line.includes("Plunder"), `got "${line}"`);
});

run("pickTensionLine: names the real other kingdom", () => {
  const line = _pickTensionLine("Falador", { traits: ["chatty"] }, () => 0);
  assert.ok(line.includes("Falador"), `expected enemy name in "${line}"`);
  assert.equal(_pickTensionLine(null, {}, () => 0), null);
});

// --- tension neighbor scan ----------------------------------------------------

run("highTensionNeighbor: finds >=80 pair with a real kingdom, no active war", () => {
  const hot = _highTensionNeighbor(
    "varrock",
    makeGetKingdom(),
    () => ({ "falador:varrock": 90 }), // canonical "a:b" keys, a < b
    () => false // no active war between them
  );
  assert.ok(hot && hot.enemyId === "falador", `expected falador, got ${JSON.stringify(hot)}`);
  assert.equal(hot.score, 90);
});

run("highTensionNeighbor: ignores below-threshold pairs", () => {
  const hot = _highTensionNeighbor("varrock", makeGetKingdom(), () => ({ "falador:varrock": 79 }), () => false);
  assert.equal(hot, null);
});

run("highTensionNeighbor: ignores pairs with a war already active", () => {
  const hot = _highTensionNeighbor(
    "varrock",
    makeGetKingdom(),
    () => ({ "falador:varrock": 95 }),
    (a, b) => ({ attackerId: a, defenderId: b, goal: "loot" }) // active war exists
  );
  assert.equal(hot, null, "a pair at war is war-chatter territory, not rumor");
});

run("highTensionNeighbor: ignores pairs with non-real kingdoms", () => {
  const hot = _highTensionNeighbor(
    "varrock",
    makeGetKingdom(), // no "nowhere" kingdom record
    () => ({ "nowhere:varrock": 99 }),
    () => false
  );
  assert.equal(hot, null, "must not rumor about kingdoms that don't exist");
});

run("highTensionNeighbor: picks the hottest pair", () => {
  const hot = _highTensionNeighbor(
    "varrock",
    makeGetKingdom(),
    () => ({ "falador:varrock": 85, "lumbridge:varrock": 92 }),
    () => false
  );
  assert.equal(hot.enemyId, "lumbridge");
});

// --- tick behavior ------------------------------------------------------------

run("tick: citizen at war speaks the real war when watched and near", () => {
  const rp = makeRealPlayer();
  const { bot, forced } = makeBot({ locals: [rp] });
  const o = makeOverrides({
    isAtWar: () => true, // cheap gate says at war
    getWars: () => [REAL_WAR_TERRITORY], // store confirms the real war
  });
  tickWarChatter(makeDirector(bot), { ...o, nowMs: 1000000 });
  assert.equal(forced.length, 1, `expected one war line, got ${forced.length}`);
  assert.ok(forced[0].includes("Falador"), `names the real enemy: "${forced[0]}"`);
  assert.ok(forced[0].includes("Territory"), `names the real goal: "${forced[0]}"`);
  assert.equal(rp.sent.length, 1, "expected chat-box delivery to the real player");
  assert.equal(o.logged.length, 1, "expected one journal entry");
  assert.equal(o.logged[0].kind, "chatted");
});

run("tick: cooldown respected (25-45 min jitter)", () => {
  const rp = makeRealPlayer();
  const { bot, forced } = makeBot({ locals: [rp] });
  const o = makeOverrides({ isAtWar: () => true, getWars: () => [REAL_WAR_TERRITORY] });
  tickWarChatter(makeDirector(bot), { ...o, nowMs: 1000000 });
  assert.equal(forced.length, 1);
  // Immediate second tick: throttled.
  tickWarChatter(makeDirector(bot), { ...o, nowMs: 1000000 + 1000 });
  assert.equal(forced.length, 1, "expected no second line within cooldown");
  // Cooldown expiry is bounded by the documented min/max.
  const nextAt = _nextChatterAt.get("mira");
  assert.ok(
    nextAt >= 1000000 + WAR_CHATTER_MIN_MS && nextAt <= 1000000 + WAR_CHATTER_MIN_MS + 20 * 60 * 1000,
    `cooldown out of 25-45min band: ${nextAt - 1000000}`
  );
});

run("tick: at-war gate true but store empty -> absolute silence (never invent)", () => {
  const rp = makeRealPlayer();
  const { bot, forced } = makeBot({ locals: [rp] });
  const o = makeOverrides({
    isAtWar: () => true, // stale alert map says war...
    getWars: () => [], // ...but the store has no war
    readTensionMap: () => ({}),
  });
  tickWarChatter(makeDirector(bot), { ...o, nowMs: 1000000 });
  assert.equal(forced.length, 0, "no store war = no speech, ever");
  assert.equal(o.logged.length, 0, "nothing to journal");
});

run("tick: not at war and no hot tension -> silent", () => {
  const rp = makeRealPlayer();
  const { bot, forced } = makeBot({ locals: [rp] });
  const o = makeOverrides({
    isAtWar: () => false,
    readTensionMap: () => ({ "falador:varrock": 40 }), // real pair, below threshold
  });
  tickWarChatter(makeDirector(bot), { ...o, nowMs: 1000000 });
  assert.equal(forced.length, 0);
});

run("tick: silent when no real player nearby", () => {
  const { bot, forced } = makeBot({ locals: [] }); // nobody watching
  const o = makeOverrides({ isAtWar: () => true, getWars: () => [REAL_WAR_TERRITORY] });
  tickWarChatter(makeDirector(bot), { ...o, nowMs: 1000000 });
  assert.equal(forced.length, 0, "expected silence when unwatched");
});

run("tick: silent for far-band citizens", () => {
  const rp = makeRealPlayer();
  const { bot, forced } = makeBot({ locals: [rp] });
  const o = makeOverrides({
    isAtWar: () => true,
    getWars: () => [REAL_WAR_TERRITORY],
    bandFor: () => BAND_FAR,
  });
  tickWarChatter(makeDirector(bot), { ...o, nowMs: 1000000 });
  assert.equal(forced.length, 0, "far citizens are unwatched");
});

run("tick: silent when citizen has no kingdom", () => {
  const rp = makeRealPlayer();
  const { bot, forced } = makeBot({ locals: [rp], kingdomId: null });
  const o = makeOverrides({ isAtWar: () => true, getWars: () => [REAL_WAR_TERRITORY] });
  tickWarChatter(makeDirector(bot), { ...o, nowMs: 1000000 });
  assert.equal(forced.length, 0, "kingdom-less citizens have no war to discuss");
});

run("tick: silent when the enemy kingdom record is missing (never invent names)", () => {
  const rp = makeRealPlayer();
  const { bot, forced } = makeBot({ locals: [rp] });
  const ghostWar = { attackerId: "varrock", defenderId: "ghost-realm", goal: "territory", goalLabel: "Territory", declaredAt: 1, declaredBy: null };
  const o = makeOverrides({ isAtWar: () => true, getWars: () => [ghostWar] });
  tickWarChatter(makeDirector(bot), { ...o, nowMs: 1000000 });
  assert.equal(forced.length, 0, "no kingdom record for the enemy = silence");
});

run("tick: tension rumor fires at >=80 with a real kingdom and no war", () => {
  const rp = makeRealPlayer();
  const { bot, forced } = makeBot({ locals: [rp] });
  const o = makeOverrides({
    isAtWar: () => false,
    readTensionMap: () => ({ "falador:varrock": 82 }),
    warBetween: () => null, // no active war
  });
  tickWarChatter(makeDirector(bot), { ...o, nowMs: 1000000 });
  assert.equal(forced.length, 1, `expected one tension rumor, got ${forced.length}`);
  assert.ok(forced[0].includes("Falador"), `rumor names the real kingdom: "${forced[0]}"`);
  assert.ok(/war/i.test(forced[0]), `rumor is about coming war: "${forced[0]}"`);
});

run("tick: no tension rumor when the hot pair is already at war", () => {
  const rp = makeRealPlayer();
  const { bot, forced } = makeBot({ locals: [rp] });
  // Gate says no war for THIS citizen's cheap check, but the hot pair check
  // finds an active war -> neither war lines nor rumors fire.
  const o = makeOverrides({
    isAtWar: () => false,
    readTensionMap: () => ({ "falador:varrock": 95 }),
    warBetween: () => ({ attackerId: "varrock", defenderId: "falador", goal: "loot" }),
  });
  tickWarChatter(makeDirector(bot), { ...o, nowMs: 1000000 });
  assert.equal(forced.length, 0);
});

run("tick: one bad citizen does not break the tick", () => {
  const rp = makeRealPlayer();
  const { bot } = makeBot({ locals: [rp] });
  const o = makeOverrides({ isAtWar: () => true, getWars: () => [REAL_WAR_TERRITORY] });
  const director = {
    roster: new Map([
      ["mira", { username: "Mira" }],
      ["bad", { username: "Bad" }],
    ]),
    isOnline: () => true,
    getBot: (rec) => {
      if (rec.username === "Bad") {
        return {
          getUsername: () => {
            throw new Error("boom");
          },
        };
      }
      return bot;
    },
  };
  tickWarChatter(director, { ...o, nowMs: 1000000 }); // must not throw
  assert.ok(true, "tick survived the bad citizen");
});

run("chatterChance: chatty high, gruff low", () => {
  assert.ok(_chatterChance({ traits: ["chatty"] }) > _chatterChance({ traits: ["gruff"] }));
  assert.equal(TENSION_RUMOR_THRESHOLD, 80);
});
