"use strict";

/**
 * CitizenRapportEvents unit checks — real proximity observations feeding the
 * citizen↔citizen rapport graph, plus the chat-heard citizen↔citizen exchange.
 *
 * FAIL-before/PASS-after shape: the rapport graph was starving (its only
 * event source was clan outings). A bare tickRelationships pass without the
 * proximity tick leaves rapport at 0 — that documents the before-state.
 *
 * No running server. CitizenBonds, CitizenJournal, CitizenSocialBonds,
 * CitizenSayPublic and the director are stubbed in the require cache (same
 * pattern as CitizenRelationships.test.js) so the write-through never
 * touches disk saves and no live modules load.
 */

const assert = require("node:assert/strict");
const path = require("node:path");

const norm = (n) => String(n ?? "").trim().toLowerCase();
const NOW = Date.now();

function stubInCache(relFromTestDir, exports) {
  const resolved = path.resolve(__dirname, relFromTestDir + ".js");
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

// --- Stub the engine layers (before requiring anything real) -------------

stubInCache("../lib/CitizenBonds", {
  normalizeName: norm,
  isFriend: () => false,
  isEnemy: () => false,
  addFriend: () => true,
  addEnemy: () => true,
  removeFriend: () => {},
  removeEnemy: () => {},
});

const journalCalls = [];
stubInCache("../lib/CitizenJournal", {
  getJournal: () => ({
    log: (name, kind, text) => journalCalls.push({ name, kind, text }),
  }),
  _calls: journalCalls,
});

const socialBondsCalls = [];
const socialBondsStub = {
  recordInteraction: (a, b, kind, opts) =>
    socialBondsCalls.push({ a, b, kind, opts }),
  standingFor: () => null, // overridden per chat scenario
};
stubInCache("../lib/CitizenSocialBonds", socialBondsStub);

const saidPublic = [];
stubInCache("../chat/CitizenSayPublic", {
  sayPublic: (bot, line) => saidPublic.push({ bot, line }),
});

// Director stub. The chat hook lazy-requires getDirector at runtime (after
// all modules load), so this cache entry is what the hook sees.
let fakeDirector = null;
stubInCache("../director/CitizenDirector", {
  getDirector: () => fakeDirector,
});

// --- Real modules under test ----------------------------------------------

const {
  tickProximityRapport,
  isRosterCitizen,
  resetForTests: resetRapportEvents,
  ACCRUAL_COOLDOWN_MS,
} = require("./CitizenRapportEvents");
const {
  noteInteraction,
  rapportOf,
  tickRelationships,
  resetForTests: resetRapport,
} = require("./CitizenRelationships");
const {
  tryScriptedReaction,
  resetForTests: resetHeard,
} = require("../chat/CitizenHeardReactions");

// --- Fakes ----------------------------------------------------------------

function makeBot(username, { personality = {} } = {}) {
  const bot = {
    username,
    getUsername: () => username,
    getAttribute: () => personality,
    _locals: [],
    getLocalPlayers: () => bot._locals,
  };
  return bot;
}

function makeDirector(names, { offline = [], botsByName = {} } = {}) {
  const roster = new Map();
  for (const n of names) {
    roster.set(norm(n), {
      username: n,
      personality: { traits: ["friendly"] },
    });
  }
  return {
    roster,
    getBot: (record) => {
      if (offline.includes(record.username)) return null;
      return botsByName[record.username] ?? null;
    },
  };
}

function colocate(bots) {
  const locals = bots.map((b) => b);
  for (const b of bots) b._locals = locals;
}

// --- Proximity tick ---------------------------------------------------------

function freshProximityWorld() {
  resetRapport();
  resetRapportEvents();
  socialBondsCalls.length = 0;
  const alice = makeBot("alice");
  const bob = makeBot("bob");
  colocate([alice, bob]);
  const director = makeDirector(["alice", "bob"], {
    botsByName: { alice, bob },
  });
  return { director, alice, bob };
}

// (a) before-state: a bare tickRelationships pass leaves rapport at 0 — the
// graph was starved. The proximity tick then accrues real observations.
{
  const { director } = freshProximityWorld();
  tickRelationships(director, NOW);
  assert.equal(
    rapportOf("alice", "bob"),
    0,
    "bare bond-formation tick leaves rapport at 0 (before-state)"
  );
  const accrued = tickProximityRapport(director, NOW);
  assert.equal(accrued, 1, "one co-located pair accrued");
  assert.ok(
    rapportOf("alice", "bob") > 0,
    "co-located roster citizens gain rapport"
  );
}

// (b) second tick inside the cooldown accrues nothing; after the cooldown it
// accrues again.
{
  const { director } = freshProximityWorld();
  tickProximityRapport(director, NOW);
  const first = rapportOf("alice", "bob");
  const accruedSoon = tickProximityRapport(
    director,
    NOW + ACCRUAL_COOLDOWN_MS / 2
  );
  assert.equal(accruedSoon, 0, "no accrual inside the cooldown window");
  assert.equal(
    rapportOf("alice", "bob"),
    first,
    "rapport unchanged inside cooldown"
  );
  const accruedLater = tickProximityRapport(
    director,
    NOW + ACCRUAL_COOLDOWN_MS + 1000
  );
  assert.equal(accruedLater, 1, "accrual resumes after the cooldown");
  assert.ok(
    rapportOf("alice", "bob") > first,
    "rapport grows on the next window"
  );
}

// (c) non-roster locals (real players) are ignored.
{
  const { director, alice, bob } = freshProximityWorld();
  const realPlayer = { getUsername: () => "realplayer" };
  alice._locals.push(realPlayer);
  bob._locals.push(realPlayer);
  tickProximityRapport(director, NOW);
  assert.equal(
    rapportOf("alice", "realplayer"),
    0,
    "real players build no rapport"
  );
  assert.equal(rapportOf("bob", "realplayer"), 0, "real players build no rapport");
  assert.ok(
    rapportOf("alice", "bob") > 0,
    "roster pair still accrues with a bystander present"
  );
}

// (d) offline citizens (getBot -> null) are skipped without breaking the tick.
{
  resetRapport();
  resetRapportEvents();
  const alice = makeBot("alice");
  const bob = makeBot("bob");
  colocate([alice, bob]);
  const director = makeDirector(["alice", "bob", "carol"], {
    botsByName: { alice, bob },
    offline: ["carol"],
  });
  const accrued = tickProximityRapport(director, NOW);
  assert.equal(accrued, 1, "only the online pair accrues");
  assert.equal(
    rapportOf("alice", "carol"),
    0,
    "offline citizen gains no rapport"
  );
  assert.ok(
    isRosterCitizen(director, "alice") && !isRosterCitizen(director, "realplayer"),
    "isRosterCitizen gates on the roster"
  );
}

// --- Chat-heard citizen<->citizen exchange -----------------------------------

function freshChatWorld() {
  resetRapport();
  resetRapportEvents();
  resetHeard();
  socialBondsCalls.length = 0;
  saidPublic.length = 0;
  const alice = makeBot("alice");
  const bob = makeBot("bob");
  fakeDirector = makeDirector(["alice", "bob"], {
    botsByName: { alice, bob },
  });
}

// A warm exchange between two roster citizens feeds the rapport graph
// through the real chat-heard path (stubbed director + sayPublic only).
{
  freshChatWorld();
  socialBondsStub.standingFor = () => "friend"; // warm: greeting becomes greetFriend
  const realRandom = Math.random;
  Math.random = () => 0; // pass the personality chance gate deterministically
  let line;
  try {
    line = tryScriptedReaction("alice", "bob", "hey!", makeBot("alice"), NOW);
  } finally {
    Math.random = realRandom;
  }
  assert.ok(line, "scripted reaction still speaks");
  assert.equal(saidPublic.length, 1, "line went through sayPublic");
  assert.ok(
    rapportOf("alice", "bob") > 0,
    "chat exchange between roster citizens builds rapport"
  );
  const writeThrough = socialBondsCalls.find(
    (c) => c.kind === "greeted" && c.opts?.mutual && c.opts?.quiet
  );
  assert.ok(
    writeThrough,
    "greeted write-through persisted through the brain layer"
  );
}

// Non-roster speaker: the roster gate drops the exchange, the reaction
// itself still speaks.
{
  freshChatWorld();
  socialBondsStub.standingFor = () => "friend";
  const realRandom = Math.random;
  Math.random = () => 0;
  let line;
  try {
    line = tryScriptedReaction("alice", "realplayer", "hey!", makeBot("alice"), NOW);
  } finally {
    Math.random = realRandom;
  }
  assert.ok(line, "reaction still speaks for non-roster speakers");
  assert.equal(
    rapportOf("alice", "realplayer"),
    0,
    "non-roster speaker builds no citizen rapport"
  );
}

// Shuns never build rapport (the cold shoulder is the message).
{
  freshChatWorld();
  socialBondsStub.standingFor = () => "rival"; // hostile: greeting becomes shun
  const realRandom = Math.random;
  Math.random = () => 0;
  const before = socialBondsCalls.length;
  try {
    tryScriptedReaction("alice", "bob", "hey!", makeBot("alice"), NOW);
  } finally {
    Math.random = realRandom;
  }
  assert.equal(rapportOf("alice", "bob"), 0, "shun builds no rapport");
  assert.equal(
    socialBondsCalls.length,
    before,
    "shun records no rapport interaction"
  );
}

// Direct roster-gated exchange logic (the hook's contract in one line).
{
  resetRapport();
  resetRapportEvents();
  noteInteraction("carol", "dave", "chatted", null, null);
  assert.ok(
    rapportOf("carol", "dave") > 0,
    "citizen<->citizen noteInteraction accrues"
  );
  assert.equal(
    noteInteraction("carol", "carol", "chatted"),
    0,
    "self-interactions are no-ops"
  );
  assert.equal(
    noteInteraction("carol", "dave", "bogus-kind"),
    0,
    "unknown kinds are no-ops"
  );
}

console.log("CitizenRapportEvents: all assertions passed");
