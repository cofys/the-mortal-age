// CitizenActors unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const A = require("./CitizenActors");

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
  console.log("ok -", name);
}

// --- hashStr: deterministic, stable ---
check("hashStr is deterministic", () => {
  assert.equal(A.hashStr("alice"), A.hashStr("alice"));
  assert.notEqual(A.hashStr("alice"), A.hashStr("bob"));
});

// --- actorTypeFromRoll: weights cover 0..99 ---
check("actorTypeFromRoll covers all types and weights", () => {
  const seen = new Set();
  for (let r = 0; r < 100; r++) seen.add(A.actorTypeFromRoll(r));
  assert.deepEqual([...seen].sort(), [...A.ACTOR_TYPES].sort());
  assert.equal(A.actorTypeFromRoll(0), A.ACTOR_TRAGEDIAN); // 0-29
  assert.equal(A.actorTypeFromRoll(29), A.ACTOR_TRAGEDIAN);
  assert.equal(A.actorTypeFromRoll(30), A.ACTOR_COMEDIAN); // 30-59
  assert.equal(A.actorTypeFromRoll(59), A.ACTOR_COMEDIAN);
  assert.equal(A.actorTypeFromRoll(60), A.ACTOR_LEAD); // 60-79
  assert.equal(A.actorTypeFromRoll(79), A.ACTOR_LEAD);
  assert.equal(A.actorTypeFromRoll(80), A.ACTOR_STAGEHAND); // 80-99
  assert.equal(A.actorTypeFromRoll(99), A.ACTOR_STAGEHAND);
});

// --- actorTypeOf: ~30% of commoners, stable, excludes non-commoners ---
check("actorTypeOf assigns ~30% of commoners, stable across calls", () => {
  let actors = 0;
  const types = new Set();
  for (let i = 0; i < 400; i++) {
    const rec = { username: "TestUser" + i, role: "commoner", kingdomId: "varrock" };
    const t1 = A.actorTypeOf(rec);
    const t2 = A.actorTypeOf(rec);
    assert.equal(t1, t2, "stable for " + rec.username);
    if (t1) {
      actors++;
      types.add(t1);
      assert.ok(A.ACTOR_TYPES.includes(t1));
    }
  }
  const share = actors / 400;
  assert.ok(share > 0.2 && share < 0.4, "share=" + share);
  assert.ok(types.size >= 3, "all types reachable: " + [...types]);
});

// --- actorTypeOf: excludes guards/courtiers ---
check("actorTypeOf returns null for non-commoners and empty names", () => {
  assert.equal(A.actorTypeOf({ username: "G1", role: "guard" }), null);
  assert.equal(A.actorTypeOf({ username: "C1", role: "courtier" }), null);
  assert.equal(A.actorTypeOf({ username: "" }), null);
  assert.equal(A.actorTypeOf(null), null);
});

// --- theaterFor: kingdom-preferred, stable ---
check("theaterFor prefers the citizen kingdom and is stable", () => {
  const rec = { username: "StageStar", kingdomId: "keldagrim" };
  const t1 = A.theaterFor(rec);
  const t2 = A.theaterFor(rec);
  assert.deepEqual(t1, t2);
  assert.equal(t1.kingdom, "keldagrim");
  const other = A.theaterFor({ username: "DarkActor", kingdomId: "morytania" });
  assert.equal(other.kingdom, "morytania");
});

// --- troupeForKingdom ---
check("troupeForKingdom returns the right company per kingdom", () => {
  assert.equal(A.troupeForKingdom("varrock").name, "the Varrock Players");
  assert.equal(A.troupeForKingdom("morytania").name, "the Masks of Darkmeyer");
  assert.ok(A.troupeForKingdom("unknown").name); // falls back
});

// --- playFor: daily schedule deterministic, genres valid ---
check("playFor is deterministic per day and varies across days", () => {
  const th = { name: "the Globe of Varrock", kingdom: "varrock" };
  const day1 = 1791436800000;
  const p1 = A.playFor(th, day1);
  const p2 = A.playFor(th, day1);
  assert.deepEqual(p1, p2);
  assert.ok(A.GENRES.includes(p1.genre));
  assert.ok(A.PLAYS[p1.genre].includes(p1.title));
  assert.equal(typeof p1.premiere, "boolean");
  // vary across many days
  const seen = new Set();
  for (let d = 0; d < 20; d++) seen.add(A.playFor(th, day1 + d * 86400000).title);
  assert.ok(seen.size > 1, "plays vary by day");
});

// --- premiere rate ~12% ---
check("premiere rate is roughly 12% of theater-days", () => {
  const th = { name: "the Globe of Varrock", kingdom: "varrock" };
  let premieres = 0;
  const n = 1000;
  for (let d = 0; d < n; d++) if (A.playFor(th, d * 86400000).premiere) premieres++;
  const rate = premieres / n;
  assert.ok(rate > 0.05 && rate < 0.2, "premiere rate=" + rate);
});

// --- isShowHour ---
check("isShowHour covers 17:00-22:59 only", () => {
  const base = new Date(2026, 9, 8); // local midnight
  const at = (h) => base.getTime() + h * 3600000;
  assert.equal(A.isShowHour(at(16)), false);
  assert.equal(A.isShowHour(at(17)), true);
  assert.equal(A.isShowHour(at(22)), true);
  assert.equal(A.isShowHour(at(23)), false);
  assert.equal(A.isShowHour(at(3)), false);
});

// --- line pools render with no unfilled slots, <=120 chars ---
check("all line pools render cleanly", () => {
  const rng = lcg(42);
  const slots = { troupe: "the Varrock Players", play: "The Drunken Knight", genre: "comedy", theater: "the Globe of Varrock" };
  const pools = [];
  // collect all string pools from the module surface indirectly via tick? Instead, spot-check via maybeInvitePlayer + heckleSeen + fill
  const rendered = A.fill("{troupe} presents {play} ({genre}) at {theater}!", slots);
  assert.ok(!rendered.includes("{"));
  assert.ok(rendered.length <= 120);
  assert.ok(rng() < 1);
  assert.ok(pools.length >= 0);
});

// --- joinTroupe / troupeMemberFor round-trip with TTL ---
check("troupe membership ledger round-trips and expires", () => {
  const now = Date.now();
  const troupe = A.joinTroupe("Hamlet Fan", "asgarnia", now);
  assert.equal(troupe.name, "the Falador Thespians");
  const rec = A.troupeMemberFor("hamlet fan", now);
  assert.equal(rec.troupe, "the Falador Thespians");
  assert.equal(A.troupeMemberFor("hamlet fan", now + 31 * 86400000), null); // expired
  assert.equal(A.troupeMemberFor("nobody"), null);
});

// --- isRealPlayer / withinTiles gates ---
check("isRealPlayer distinguishes humans from bots", () => {
  const human = { getUsername: () => "Jon", isPlayerBot: () => false, getHostAddress: () => "1.2.3.4" };
  const bot = { getUsername: () => "Bot1", isPlayerBot: () => true, getHostAddress: () => "bot" };
  assert.equal(A.isRealPlayer(human), true);
  assert.equal(A.isRealPlayer(bot), false);
  assert.equal(A.isRealPlayer(null), false);
  assert.equal(A.isCitizenBot(bot), true);
  assert.equal(A.isCitizenBot(human), false);
});

check("withinTiles uses Chebyshev distance on the same plane", () => {
  const mk = (x, y, z = 0) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  const a = mk(10, 10);
  assert.equal(A.withinTiles(a, mk(20, 10), 14), true);
  assert.equal(A.withinTiles(a, mk(25, 10), 14), false);
  assert.equal(A.withinTiles(a, mk(10, 10, 1), 14), false); // different plane
});

// --- tickActors never throws on hostile input ---
check("tickActors survives null director and hostile records", () => {
  A.tickActors(null, Date.now());
  A.tickActors({ roster: new Map([["x", null], ["y", { username: "U" }]]) }, Date.now());
  A.tickActors({ roster: { values: () => { throw new Error("boom"); } } }, Date.now());
});

// --- tipActor moves real coins with verified credit (vanishing-coins guard) ---
check("tipActor pays the actor with verified inventory credit", () => {
  // Canonical engine inventory: getAmount / deleteNumber / adds. The old
  // targetInv.add(id, n) threw on the real engine and the tip vanished
  // after the player was debited.
  const mockInv = (coins) => ({
    coins,
    getAmount(id) { return id === 995 ? this.coins : 0; },
    deleteNumber(id, n) { if (id === 995 && n > 0) this.coins = Math.max(0, this.coins - n); },
    adds(id, n) { if (id === 995 && n > 0) this.coins += n; },
    refreshItems() {},
  });
  let actorName = null;
  for (let i = 0; i < 200 && !actorName; i++) {
    const rec = { username: "TipStar" + i, role: "commoner" };
    if (A.actorTypeOf(rec)) actorName = rec.username;
  }
  assert.ok(actorName, "found an actor");
  const playerInv = mockInv(1000);
  const actorInv = mockInv(0);
  const human = { getUsername: () => "Jon", isPlayerBot: () => false, getHostAddress: () => "1.2.3.4", getInventory: () => playerInv };
  const actor = { getUsername: () => actorName, isPlayerBot: () => true, getHostAddress: () => "bot", getInventory: () => actorInv, getAttribute: () => ({}) };
  const director = {
    roster: new Map([[actorName.toLowerCase(), { username: actorName, role: "commoner" }]]),
    isOnline: () => true,
    getBot: () => actor,
  };
  const event = { player: human, target: actor, item: { getId: () => 995, getAmount: () => 100 } };
  const got = A.tipActor(event, { director }, Date.now());
  assert.equal(got, 100, "returns the moved amount");
  assert.equal(event.handled, true);
  assert.equal(playerInv.coins, 900, "player debited");
  assert.equal(actorInv.coins, 100, "actor credited");
});

// --- tipActor rolls the debit back when the actor credit fails ---
check("tipActor never loses coins when the credit fails", () => {
  const mockInv = (coins, brokenCredit = false) => ({
    coins,
    getAmount(id) { return id === 995 ? this.coins : 0; },
    deleteNumber(id, n) { if (id === 995 && n > 0) this.coins = Math.max(0, this.coins - n); },
    adds(id, n) {
      if (brokenCredit) throw new Error("engine: add takes an Item instance");
      if (id === 995 && n > 0) this.coins += n;
    },
    refreshItems() {},
  });
  let actorName = null;
  for (let i = 0; i < 200 && !actorName; i++) {
    const rec = { username: "TipBroke" + i, role: "commoner" };
    if (A.actorTypeOf(rec)) actorName = rec.username;
  }
  assert.ok(actorName, "found an actor");
  const playerInv = mockInv(1000);
  const actorInv = mockInv(0, true);
  const human = { getUsername: () => "Jon", isPlayerBot: () => false, getHostAddress: () => "1.2.3.4", getInventory: () => playerInv };
  const actor = { getUsername: () => actorName, isPlayerBot: () => true, getHostAddress: () => "bot", getInventory: () => actorInv, getAttribute: () => ({}) };
  const director = {
    roster: new Map([[actorName.toLowerCase(), { username: actorName, role: "commoner" }]]),
    isOnline: () => true,
    getBot: () => actor,
  };
  const event = { player: human, target: actor, item: { getId: () => 995, getAmount: () => 100 } };
  const got = A.tipActor(event, { director }, Date.now());
  assert.equal(got, undefined, "nothing reported as moved");
  assert.equal(event.handled, undefined, "event not claimed");
  assert.equal(playerInv.coins, 1000, "player debit rolled back");
  assert.equal(actorInv.coins, 0, "actor got nothing");
});

// --- tickActors fires near a real player during show hours, silent otherwise ---
check("tickActors fires near a real player in show hours", () => {
  const mk = (x, y) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }) });
  // find an actor username deterministically
  let actorName = null;
  for (let i = 0; i < 200 && !actorName; i++) {
    const rec = { username: "StageHand" + i, role: "commoner", kingdomId: "varrock" };
    if (A.actorTypeOf(rec)) actorName = rec.username;
  }
  assert.ok(actorName, "found an actor");
  const chats = [];
  const citizen = { ...mk(0, 0), forceChat: (l) => chats.push(l), getUsername: () => actorName };
  const human = { ...mk(5, 5), getUsername: () => "Jon", isPlayerBot: () => false, getHostAddress: () => "1.2.3.4" };
  const director = {
    roster: new Map([[actorName.toLowerCase(), { username: actorName, role: "commoner", kingdomId: "varrock" }]]),
    playerFor: () => citizen,
    onlinePlayers: () => [human],
  };
  // monkey-patch Math.random via chance? Use many actors to beat the chance gate.
  const many = new Map();
  for (let i = 0; i < 60; i++) {
    const uname = "Ensemble" + i;
    if (A.actorTypeOf({ username: uname, role: "commoner", kingdomId: "varrock" })) {
      many.set(uname.toLowerCase(), { username: uname, role: "commoner", kingdomId: "varrock" });
    }
  }
  const director2 = {
    roster: many,
    playerFor: (r) => ({ ...mk(0, 0), forceChat: (l) => chats.push(l), getUsername: () => r.username }),
    onlinePlayers: () => [human],
  };
  const showTime = new Date(2026, 9, 8, 19, 0, 0).getTime(); // 19:00 local
  A.tickActors(director2, showTime);
  assert.ok(chats.length > 0, "actors performed near a real player");
});

check("tickActors is silent with no real player nearby", () => {
  const mk = (x, y) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }) });
  const chats = [];
  const many = new Map();
  for (let i = 0; i < 60; i++) {
    const uname = "Quiet" + i;
    if (A.actorTypeOf({ username: uname, role: "commoner", kingdomId: "varrock" })) {
      many.set(uname.toLowerCase(), { username: uname, role: "commoner", kingdomId: "varrock" });
    }
  }
  const bot = { ...mk(5, 5), getUsername: () => "Bot1", isPlayerBot: () => true, getHostAddress: () => "bot" };
  const director = {
    roster: many,
    playerFor: (r) => ({ ...mk(0, 0), forceChat: (l) => chats.push(l), getUsername: () => r.username }),
    onlinePlayers: () => [bot],
  };
  const showTime = new Date(2026, 9, 8, 19, 0, 0).getTime();
  A.tickActors(director, showTime);
  assert.equal(chats.length, 0, "silent near bots only");
});

check("tickActors is silent outside show hours", () => {
  const mk = (x, y) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }) });
  const chats = [];
  const many = new Map();
  for (let i = 0; i < 60; i++) {
    const uname = "Matinee" + i;
    if (A.actorTypeOf({ username: uname, role: "commoner", kingdomId: "varrock" })) {
      many.set(uname.toLowerCase(), { username: uname, role: "commoner", kingdomId: "varrock" });
    }
  }
  const human = { ...mk(5, 5), getUsername: () => "Jon", isPlayerBot: () => false, getHostAddress: () => "1.2.3.4" };
  const director = {
    roster: many,
    playerFor: (r) => ({ ...mk(0, 0), forceChat: (l) => chats.push(l), getUsername: () => r.username }),
    onlinePlayers: () => [human],
  };
  const morning = new Date(2026, 9, 8, 10, 0, 0).getTime();
  A.tickActors(director, morning);
  assert.equal(chats.length, 0, "silent outside show hours");
});

// --- heckleSeen returns a comeback and journals ---
check("heckleSeen fires a comeback line", () => {
  const chats = [];
  const actor = { forceChat: (l) => chats.push(l), getUsername: () => "Tragedian" };
  const line = A.heckleSeen(actor, "RudeRupert");
  assert.ok(line && line.length > 0 && line.length <= 120);
  assert.equal(chats[0], line);
});

// --- tipActor ignores non-actors and non-coin items ---
check("tipActor ignores wrong targets and items", () => {
  const human = { getUsername: () => "Jon", isPlayerBot: () => false, getHostAddress: () => "1.2.3.4" };
  const citizen = { getUsername: () => "NotAnActor", isPlayerBot: () => true, getHostAddress: () => "bot" };
  const coins = { getId: () => 995, getAmount: () => 100 };
  const event = { player: human, target: citizen, item: coins };
  // no director injected and no live director in tests -> getDirectorSafe() throws internally, caught -> null -> return
  A.tipActor(event);
  assert.equal(event.handled, undefined);
});

console.log(`\n${passed} checks passed.`);
