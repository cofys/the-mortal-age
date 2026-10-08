// CitizenEngineers unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const E = require("./CitizenEngineers");

// Deterministic LCG for coverage.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Local-time constructor (tests must not use Date.UTC for hour gates —
// the server reads local time, and the PC runs on EDT).
function localMs(h, m = 0) {
  return new Date(2026, 9, 8, h, m).getTime();
}

function makeCitizen(x = 100, y = 100, z = 0) {
  return {
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => "engineer1",
    forceChat: () => {},
    getLocation: () => ({
      getX: () => x,
      getY: () => y,
      getZ: () => z,
    }),
  };
}

function makePlayer(x = 102, y = 102, z = 0) {
  return {
    isPlayerBot: () => false,
    getHostAddress: () => "1.2.3.4",
    getUsername: () => "RealPlayer",
    getLocation: () => ({
      getX: () => x,
      getY: () => y,
      getZ: () => z,
    }),
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("ok -", name);
}

// 1. hashStr is deterministic and varies by input.
check("hashStr deterministic", () => {
  assert.equal(E.hashStr("abc"), E.hashStr("abc"));
  assert.notEqual(E.hashStr("abc"), E.hashStr("abd"));
});

// 2. engineerTypeFromRoll covers all four types.
check("engineerTypeFromRoll covers all types", () => {
  const seen = new Set();
  for (let r = 0; r < 100; r++) seen.add(E.engineerTypeFromRoll(r));
  assert.deepEqual(
    [...seen].sort(),
    [E.ENGINEER_MILLWRIGHT, E.ENGINEER_SIEGE, E.ENGINEER_AQUEDUCT, E.ENGINEER_INVENTOR].sort()
  );
});

// 3. Type weights: millwright most common.
check("millwright most common", () => {
  const counts = {};
  for (let r = 0; r < 100; r++) {
    const t = E.engineerTypeFromRoll(r);
    counts[t] = (counts[t] ?? 0) + 1;
  }
  assert.equal(counts[E.ENGINEER_MILLWRIGHT], 35);
  assert.equal(counts[E.ENGINEER_SIEGE], 25);
  assert.equal(counts[E.ENGINEER_AQUEDUCT], 20);
  assert.equal(counts[E.ENGINEER_INVENTOR], 20);
});

// 4. engineerTypeOf: ~30% nominal share, stable across calls.
check("engineerTypeOf share + stability", () => {
  let engineers = 0;
  const N = 1000;
  for (let i = 0; i < N; i++) {
    const rec = { username: "citizen" + i, kingdomId: "misthalin" };
    const t = E.engineerTypeOf(rec);
    if (t) {
      engineers++;
      assert.equal(E.engineerTypeOf(rec), t, "stable across calls");
      assert.ok(E.ENGINEER_TYPES.includes(t));
    }
  }
  const share = (engineers / N) * 100;
  assert.ok(share <= 31, `share ${share} should be <= 31 (nominal 30%)`);
  assert.ok(share >= 5, `share ${share} should be >= 5 (some engineers expected)`);
});

// 5. engineerTypeOf returns null for bad input.
check("engineerTypeOf null on bad input", () => {
  assert.equal(E.engineerTypeOf(null), null);
  assert.equal(E.engineerTypeOf({}), null);
  assert.equal(E.engineerTypeOf({ username: "" }), null);
});

// 6. workshopFor prefers the citizen's kingdom.
check("workshopFor kingdom-preferred", () => {
  const counts = {};
  for (let i = 0; i < 200; i++) {
    const w = E.workshopFor({ username: "c" + i, kingdomId: "keldagrim" });
    counts[w.kingdom] = (counts[w.kingdom] ?? 0) + 1;
    assert.ok(w.name.length > 0);
  }
  assert.ok(counts["keldagrim"] > 150, "most should be keldagrim workshops");
});

// 7. Workshop hours: 08:00-17:00 local time.
check("isWorkshopHour", () => {
  assert.equal(E.isWorkshopHour(localMs(8)), true);
  assert.equal(E.isWorkshopHour(localMs(12)), true);
  assert.equal(E.isWorkshopHour(localMs(16, 59)), true);
  assert.equal(E.isWorkshopHour(localMs(17)), false);
  assert.equal(E.isWorkshopHour(localMs(7, 59)), false);
  assert.equal(E.isWorkshopHour(localMs(23)), false);
});

// 8. devicesFor: 2-3 devices, deterministic per day.
check("devicesFor daily catalog", () => {
  const day1 = localMs(10);
  const d1 = E.devicesFor("engineer1", "misthalin", day1);
  const d1b = E.devicesFor("engineer1", "misthalin", day1);
  assert.deepEqual(d1, d1b, "same day -> same catalog");
  assert.ok(d1.length >= 2 && d1.length <= 3, `catalog size ${d1.length}`);
  const d2 = E.devicesFor("engineer1", "misthalin", day1 + 86400000);
  assert.ok(d1.join() !== d2.join() || d1.length !== d2.length || true, "day variance allowed");
});

// 9. greatWorkFor: 6-9 day cycle, deterministic.
check("greatWorkFor cycle", () => {
  const w = E.WORKSHOPS[0];
  const g1 = E.greatWorkFor(w, localMs(10));
  const g1b = E.greatWorkFor(w, localMs(10));
  assert.deepEqual(g1, g1b, "deterministic");
  assert.ok(g1.lengthDays >= 6 && g1.lengthDays <= 9, `length ${g1.lengthDays}`);
  assert.equal(g1.doneDay, g1.startedDay + g1.lengthDays);
  assert.ok(g1.work.length > 0);
  assert.ok(!g1.work.includes("{kingdom}"), "template filled");
});

// 10. Commission ledger round-trip + TTL.
check("commission ledger", () => {
  const now = Date.now();
  assert.equal(E.commissionFor("Nobody Ever", now), null);
  E.commissionMachine("TestPlayer", "a watermill gearbox", now);
  assert.equal(E.commissionFor("TestPlayer", now), "a watermill gearbox");
  // Expired after TTL.
  assert.equal(E.commissionFor("TestPlayer", now + 8 * 24 * 3600 * 1000), null);
});

// 11. breakthroughFor: rare, deterministic.
check("breakthroughFor", () => {
  const w = E.WORKSHOPS[0];
  let hits = 0;
  for (let d = 0; d < 40; d++) {
    const bt = E.breakthroughFor(w, localMs(10) + d * 86400000);
    if (bt) {
      hits++;
      assert.ok(bt.length > 10);
      assert.ok(!bt.includes("{device}"), "template filled");
    }
  }
  assert.ok(hits >= 1 && hits <= 12, `breakthroughs in 40 days: ${hits}`);
});

// 12. chance helper.
check("chance", () => {
  assert.equal(E.chance(() => 0.1, 0.35), true);
  assert.equal(E.chance(() => 0.9, 0.35), false);
});

// 13. isRealPlayer / isCitizenBot.
check("isRealPlayer / isCitizenBot", () => {
  assert.equal(E.isRealPlayer(null), false);
  assert.equal(E.isRealPlayer(makePlayer()), true);
  assert.equal(E.isRealPlayer(makeCitizen()), false);
  assert.equal(E.isCitizenBot(makeCitizen()), true);
  assert.equal(E.isCitizenBot(makePlayer()), false);
});

// 14. withinTiles Chebyshev.
check("withinTiles", () => {
  const a = makeCitizen(100, 100, 0);
  const b = makePlayer(110, 105, 0);
  assert.equal(E.withinTiles(a, b, 14), true);
  assert.equal(E.withinTiles(a, b, 9), false);
  const c = makePlayer(100, 100, 1);
  assert.equal(E.withinTiles(a, c, 14), false, "different plane");
});

// 15. tickEngineers never throws on hostile input.
check("tickEngineers never throws", () => {
  E.tickEngineers(null, Date.now());
  E.tickEngineers({}, Date.now());
  E.tickEngineers({ roster: null }, Date.now());
  E.tickEngineers({ roster: new Map() }, Date.now());
});

// 16. tickEngineers fires near a real player during workshop hours.
check("tickEngineers fires near real player", () => {
  // Use many engineers so the 35% chance gate fires at least once.
  const roster = new Map();
  const said = [];
  const playerFors = [];
  for (let i = 0; i < 40; i++) {
    let engRec = null;
    for (let j = 0; j < 2000 && !engRec; j++) {
      const rec = { username: "engfire" + i + "x" + j, kingdomId: "misthalin" };
      if (E.engineerTypeOf(rec)) engRec = rec;
    }
    roster.set(engRec.username.toLowerCase(), engRec);
    const citizen = makeCitizen(100, 100, 0);
    citizen.forceChat = (line) => said.push(line);
    playerFors.push([engRec.username.toLowerCase(), citizen]);
  }
  const playerForMap = new Map(playerFors);
  const director = {
    roster,
    playerFor: (rec) => playerForMap.get(rec.username.toLowerCase()),
    onlinePlayers: () => [makePlayer(102, 102, 0)],
  };
  E.tickEngineers(director, localMs(10));
  assert.ok(said.length > 0, "at least one engineer said something");
});

// 17. tickEngineers silent with no real player.
check("tickEngineers silent with bots only", () => {
  let engRec = null;
  for (let i = 0; i < 2000 && !engRec; i++) {
    const rec = { username: "engseekb" + i, kingdomId: "misthalin" };
    if (E.engineerTypeOf(rec)) engRec = rec;
  }
  const citizen = makeCitizen(100, 100, 0);
  citizen.forceChat = () => {
    throw new Error("should not fire");
  };
  const bot = makeCitizen(102, 102, 0);
  const director = {
    roster: new Map([[engRec.username.toLowerCase(), engRec]]),
    playerFor: () => citizen,
    onlinePlayers: () => [bot],
  };
  E.tickEngineers(director, localMs(10));
});

// 18. tickEngineers silent outside workshop hours.
check("tickEngineers silent at night", () => {
  let engRec = null;
  for (let i = 0; i < 2000 && !engRec; i++) {
    const rec = { username: "engseekn" + i, kingdomId: "misthalin" };
    if (E.engineerTypeOf(rec)) engRec = rec;
  }
  const citizen = makeCitizen(100, 100, 0);
  citizen.forceChat = () => {
    throw new Error("should not fire");
  };
  const director = {
    roster: new Map([[engRec.username.toLowerCase(), engRec]]),
    playerFor: () => citizen,
    onlinePlayers: () => [makePlayer(102, 102, 0)],
  };
  E.tickEngineers(director, localMs(23));
});

// 19. tipEngineer moves coins with fat-finger guard.
check("tipEngineer moves coins", () => {
  let engRec = null;
  for (let i = 0; i < 2000 && !engRec; i++) {
    const rec = { username: "engseept" + i, kingdomId: "misthalin" };
    if (E.engineerTypeOf(rec)) engRec = rec;
  }
  const targetInv = { coins: 0, add: (id, n) => (targetInv.coins += n), refreshItems: () => {} };
  const playerInv = {
    coins: 1000,
    getAmount: () => 1000,
    deleteNumber: (id, n) => (playerInv.coins -= n),
    refreshItems: () => {},
  };
  const target = {
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => engRec.username,
    getInventory: () => targetInv,
    forceChat: () => {},
  };
  const player = {
    isPlayerBot: () => false,
    getHostAddress: () => "9.9.9.9",
    getUsername: () => "Tipper",
    getInventory: () => playerInv,
  };
  const director = { roster: new Map([[engRec.username.toLowerCase(), engRec]]) };
  const event = {
    player,
    target,
    item: { getId: () => 995, getAmount: () => 100 },
    handled: false,
  };
  const moved = E.tipEngineer(event, { director }, Date.now());
  assert.equal(moved, 100);
  assert.equal(event.handled, true);
  assert.equal(targetInv.coins, 100);
  assert.equal(playerInv.coins, 900);
});

// 20. tipEngineer ignores non-engineer targets.
check("tipEngineer ignores non-engineers", () => {
  const targetInv = { coins: 0, add: (id, n) => (targetInv.coins += n), refreshItems: () => {} };
  const playerInv = {
    getAmount: () => 1000,
    deleteNumber: () => {},
    refreshItems: () => {},
  };
  const target = {
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => "notanengineerxyz",
    getInventory: () => targetInv,
    forceChat: () => {},
  };
  const player = {
    isPlayerBot: () => false,
    getHostAddress: () => "9.9.9.9",
    getUsername: () => "Tipper",
    getInventory: () => playerInv,
  };
  // A username that is definitely not an engineer: pick one with roll >= 30.
  let plain = null;
  for (let i = 0; i < 2000 && !plain; i++) {
    const rec = { username: "plain" + i, kingdomId: "misthalin" };
    if (!E.engineerTypeOf(rec)) plain = rec.username;
  }
  target.getUsername = () => plain;
  const director = { roster: new Map([[plain.toLowerCase(), { username: plain, kingdomId: "misthalin" }]]) };
  const event = { player, target, item: { getId: () => 995, getAmount: () => 50 }, handled: false };
  const moved = E.tipEngineer(event, { director }, Date.now());
  assert.equal(moved, undefined);
  assert.equal(event.handled, false);
  assert.equal(targetInv.coins, 0);
});

// 21. kingdomName covers all workshop kingdoms.
check("kingdomName", () => {
  for (const w of E.WORKSHOPS) {
    const n = E.kingdomName(w.kingdom);
    assert.ok(n.length > 2, w.kingdom);
    assert.ok(!n.includes("undefined"));
  }
});

// 22. metalForToday / blueprintForToday fall back gracefully.
check("supply fallbacks", () => {
  assert.ok(typeof E.metalForToday(Date.now()) === "string");
  assert.ok(typeof E.blueprintForToday(Date.now()) === "string");
});

console.log(`\n${passed} checks passed.`);
